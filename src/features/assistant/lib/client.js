// Claude API calls with the user's own key, straight from this browser to api.anthropic.com through
// the official SDK (@anthropic-ai/sdk, loaded on first use as its own chunk). `dangerouslyAllowBrowser`
// makes the SDK send the direct-browser-access header; the key is the user's own, in their own browser.
//
// Requests: streamed with max_tokens 64000 and output_config.effort from the settings; no `thinking`
// and no sampling parameters (Claude Opus 5.5 rejects both). Opus and Sonnet go through the beta
// endpoint with the server-side refusal fallback (`fallbacks: 'default'`); Haiku has none.
import {
  DEFAULT_EFFORT, DEFAULT_MODEL, FALLBACK_BETA, FALLBACK_MODELS, STREAM_MAX_TOKENS, TEST_MAX_TOKENS, isEffort, isModel,
} from './config.js';

let sdkPromise = null;

/** The SDK's Anthropic class (dynamic import, cached; a failed load is retried next time). */
export function loadSdk() {
  if (!sdkPromise) {
    sdkPromise = import('@anthropic-ai/sdk')
      .then((mod) => mod.default || mod.Anthropic)
      .catch((e) => {
        sdkPromise = null;
        throw e;
      });
  }
  return sdkPromise;
}

/** A client for one request. maxRetries 0: errors (429 retry-after, 529) are shown, with a Retry button. */
export async function makeClient(apiKey) {
  const Anthropic = await loadSdk();
  return { Anthropic, client: new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 0 }) };
}

/**
 * The streamed request for a model. Pure, so the unit tests check exactly what is sent.
 * -> { beta: boolean, params }
 */
export function buildStreamParams({ model, effort, system, messages }) {
  const m = isModel(model) ? model : DEFAULT_MODEL;
  const params = {
    model: m,
    max_tokens: STREAM_MAX_TOKENS,
    output_config: { effort: isEffort(effort) ? effort : DEFAULT_EFFORT },
    messages,
  };
  if (system) params.system = system;
  if (FALLBACK_MODELS.includes(m)) {
    return { beta: true, params: { ...params, betas: [FALLBACK_BETA], fallbacks: 'default' } };
  }
  return { beta: false, params };
}

/** The tiny non-streamed "Test key" request. */
export function buildTestParams(model) {
  return {
    model: isModel(model) ? model : DEFAULT_MODEL,
    max_tokens: TEST_MAX_TOKENS,
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
  };
}

/** True when a fallback model answered (served-by signal in usage.iterations, or a fallback block). */
export function fellBack(message) {
  const iters = message?.usage?.iterations;
  if (Array.isArray(iters) && iters.some((e) => e?.type === 'fallback_message')) return true;
  return Array.isArray(message?.content) && message.content.some((b) => b?.type === 'fallback');
}

/**
 * Stream one reply. onText(delta) gets each text_delta as it arrives.
 * Resolves { text, stopReason, stopDetails, model, usage, fellBack, aborted }.
 * Aborting through `signal` resolves with aborted: true and the text so far; API errors reject
 * (map them with describeError(err, Anthropic) — `Anthropic` is on the rejection as err.sdk).
 */
export async function streamReply({ apiKey, model, effort, system, messages, signal, onText }) {
  if (!apiKey) throw new Error('Add your Anthropic API key in Settings → Assistant first.');
  const { Anthropic, client } = await makeClient(apiKey);
  if (signal?.aborted) return { text: '', aborted: true, stopReason: null, usage: null };
  const { beta, params } = buildStreamParams({ model, effort, system, messages });
  let text = '';
  let stream;
  try {
    stream = beta ? client.beta.messages.stream(params, { signal }) : client.messages.stream(params, { signal });
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
        text += event.delta.text;
        onText?.(event.delta.text, text);
      }
    }
    const msg = await stream.finalMessage();
    return {
      text,
      stopReason: msg.stop_reason ?? null,
      stopDetails: msg.stop_details ?? null,
      model: typeof msg.model === 'string' ? msg.model : params.model,
      usage: msg.usage || null,
      fellBack: fellBack(msg),
      aborted: false,
    };
  } catch (err) {
    if (signal?.aborted || err instanceof Anthropic.APIUserAbortError) {
      return { text, aborted: true, stopReason: null, usage: null };
    }
    if (err && typeof err === 'object') err.sdk = Anthropic;
    throw err;
  }
}

/** "Test key": one tiny request. Resolves { model, usage }; rejects like streamReply. */
export async function testKey({ apiKey, model }) {
  const { Anthropic, client } = await makeClient(apiKey);
  try {
    const msg = await client.messages.create(buildTestParams(model));
    return { model: msg.model, usage: msg.usage || null };
  } catch (err) {
    if (err && typeof err === 'object') err.sdk = Anthropic;
    throw err;
  }
}
