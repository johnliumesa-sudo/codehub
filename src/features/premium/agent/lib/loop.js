// The agent loop: a manual, streamed tool-use loop over the Messages API (claude-api skill, TypeScript
// "Streaming Manual Loop"). Pure: the SDK client and its APIError class are passed in, so the unit tests
// drive it with a fake client.
//
// Each turn: stream the request (text deltas go to onEvent as they arrive), take finalMessage(), then
//   - end_turn / stop_sequence: done;
//   - refusal: stop and never run that turn's tools (a refusal can cut a tool_use off mid-input);
//   - max_tokens with a tool_use: stop without running it (a truncated input can still parse);
//   - pause_turn: append the turn and continue (bounded);
//   - tool_use: validate every parsed input against its schema (eager_input_streaming means the API
//     did not), run the valid ones in order through `runTool`, answer every tool_use id in ONE user
//     message (invalid ones as is_error INVALID_JSON results), and loop.
// The full assistant content (thinking blocks included) is appended unchanged, so preserved thinking
// stays valid. An input the SDK cannot parse at all rejects the stream: only that (never an API error)
// re-issues the turn, at most twice in a row. A tool-call cap ends the run; abort ends it at once.
import { validateInput } from './schema.js';

export const DEFAULT_MAX_TOOL_CALLS = 50;
const MAX_JSON_RETRIES = 2;
const MAX_PAUSE_CONTINUES = 5;

export class AgentAborted extends Error {
  constructor() {
    super('Stopped.');
    this.name = 'AgentAborted';
  }
}

const errorResult = (id, text) => ({ type: 'tool_result', tool_use_id: id, is_error: true, content: text });

/**
 * Close a conversation whose last assistant turn has tool_use blocks without results (Stop pressed
 * while tools ran, or the tool-call cap), so a follow-up request is valid. `results` are the ones
 * already produced. Mutates `messages`.
 */
export function closeOpenToolUses(messages, results, reason) {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant' || !Array.isArray(last.content)) return;
  const done = new Set(results.map((r) => r.tool_use_id));
  const all = [...results];
  for (const b of last.content) {
    if (b?.type === 'tool_use' && !done.has(b.id)) all.push(errorResult(b.id, reason));
  }
  if (all.length) messages.push({ role: 'user', content: all });
}

/**
 * Append a user message, merging into a trailing user message (tool results) so roles alternate.
 * Mutates `messages`.
 */
export function pushUserText(messages, text) {
  const last = messages[messages.length - 1];
  if (last && last.role === 'user') {
    const content = Array.isArray(last.content) ? last.content : [{ type: 'text', text: String(last.content) }];
    last.content = [...content, { type: 'text', text }];
  } else {
    messages.push({ role: 'user', content: text });
  }
}

/**
 * Run until Claude stops calling tools.
 * @param {object} o
 * @param {object} o.client       SDK client (or a fake): client.messages.stream / client.beta.messages.stream
 * @param {boolean} o.beta        use the beta endpoint (server-side refusal fallback)
 * @param {object} o.params       request params without `messages` (model, max_tokens, system, tools, …)
 * @param {Array} o.messages      conversation, mutated in place (assistant turns and tool results appended)
 * @param {Function} o.APIError   the SDK's APIError class: such errors are never retried, they reject
 * @param {Function} o.runTool    async (block) => { content: string, isError?: boolean }; may throw AgentAborted
 * @param {number} [o.maxToolCalls]
 * @param {AbortSignal} [o.signal]
 * @param {Function} [o.onEvent]  ({ type: 'text', text } | { type: 'thinking' } | { type: 'tool', name } |
 *                                 { type: 'turn', message } | { type: 'retry' } | { type: 'invalid', name, reason })
 * @returns {Promise<{ reason: 'end_turn'|'refusal'|'max_tokens'|'context'|'cap'|'aborted'|'paused', toolCalls: number, message?: object }>}
 */
export async function runAgentLoop({ client, beta = false, params, messages, APIError, runTool, maxToolCalls = DEFAULT_MAX_TOOL_CALLS, signal, onEvent = () => {} }) {
  let toolCalls = 0;
  let jsonRetries = 0;
  let pauses = 0;
  const aborted = () => !!signal?.aborted;

  for (;;) {
    if (aborted()) return { reason: 'aborted', toolCalls };
    const req = { ...params, messages };
    let message;
    try {
      const stream = beta ? client.beta.messages.stream(req, { signal }) : client.messages.stream(req, { signal });
      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          if (event.content_block?.type === 'tool_use') onEvent({ type: 'tool', name: event.content_block.name });
          else if (event.content_block?.type === 'thinking' || event.content_block?.type === 'redacted_thinking') onEvent({ type: 'thinking' });
        } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
          onEvent({ type: 'text', text: event.delta.text });
        }
      }
      message = await stream.finalMessage();
    } catch (err) {
      if (aborted()) return { reason: 'aborted', toolCalls };
      // Only a tool input the SDK could not parse is retried; API errors (auth, 429, 529, …) reject.
      if ((typeof APIError === 'function' && err instanceof APIError) || jsonRetries >= MAX_JSON_RETRIES) throw err;
      jsonRetries += 1;
      onEvent({ type: 'retry' });
      continue;
    }
    jsonRetries = 0;
    onEvent({ type: 'turn', message });

    const content = Array.isArray(message.content) ? message.content : [];
    const toolUses = content.filter((b) => b?.type === 'tool_use');
    const stop = message.stop_reason;

    if (stop === 'refusal') return { reason: 'refusal', toolCalls, message };
    if (stop === 'max_tokens' && toolUses.length) return { reason: 'max_tokens', toolCalls, message };
    if (stop === 'model_context_window_exceeded') return { reason: 'context', toolCalls, message };
    if (stop === 'pause_turn') {
      messages.push({ role: 'assistant', content });
      if (++pauses > MAX_PAUSE_CONTINUES) return { reason: 'paused', toolCalls, message };
      continue;
    }
    messages.push({ role: 'assistant', content });
    if (stop !== 'tool_use' || !toolUses.length) {
      return { reason: stop === 'max_tokens' ? 'max_tokens' : 'end_turn', toolCalls, message };
    }

    const results = [];
    let capped = false;
    for (const block of toolUses) {
      if (aborted()) {
        closeOpenToolUses(messages, results, 'Not run: the member stopped the agent.');
        return { reason: 'aborted', toolCalls };
      }
      if (toolCalls >= maxToolCalls) {
        capped = true;
        results.push(errorResult(block.id, `Not run: this run reached its limit of ${maxToolCalls} tool calls.`));
        continue;
      }
      toolCalls += 1;
      const bad = validateInput(block.name, block.input);
      if (bad) {
        onEvent({ type: 'invalid', name: block.name, reason: bad });
        results.push(errorResult(block.id, JSON.stringify({ INVALID_JSON: JSON.stringify(block.input ?? null), error: bad })));
        continue;
      }
      let out;
      try {
        out = await runTool(block);
      } catch (err) {
        if (err instanceof AgentAborted || aborted()) {
          closeOpenToolUses(messages, results, 'Not run: the member stopped the agent.');
          return { reason: 'aborted', toolCalls };
        }
        out = { content: `Tool failed: ${String(err?.message || err)}`, isError: true };
      }
      results.push(out.isError ? errorResult(block.id, out.content) : { type: 'tool_result', tool_use_id: block.id, content: out.content });
    }
    messages.push({ role: 'user', content: results });
    if (capped) return { reason: 'cap', toolCalls };
  }
}
