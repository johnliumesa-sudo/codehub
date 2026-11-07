// Turning Claude API outcomes into plain messages: SDK errors (by class, then by .status / .type) and
// stop reasons. Pure: the SDK class is passed in (`A` = the default export of @anthropic-ai/sdk), so
// the unit tests use the real error classes without a browser.

/** Seconds to wait from a response's retry-after-ms / retry-after headers, or null. */
export function parseRetryAfter(headers, now = Date.now()) {
  const get = (k) => {
    try {
      if (!headers) return null;
      if (typeof headers.get === 'function') return headers.get(k);
      return headers[k] ?? null;
    } catch {
      return null;
    }
  };
  const ms = parseFloat(get('retry-after-ms'));
  if (Number.isFinite(ms) && ms > 0) return Math.max(1, Math.ceil(ms / 1000));
  const raw = get('retry-after');
  if (raw === null || raw === undefined || raw === '') return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return secs > 0 ? Math.ceil(secs) : null;
  const at = Date.parse(String(raw));
  if (!Number.isFinite(at)) return null;
  const diff = Math.ceil((at - now) / 1000);
  return diff > 0 ? diff : null;
}

const is = (err, Cls) => typeof Cls === 'function' && err instanceof Cls;

/**
 * -> { kind, title, message, retryAfter?, status? }
 * kind: aborted | auth | permission | rateLimit | connection | timeout | overloaded | billing |
 *       notFound | badRequest | tooLarge | server | api | load | other
 */
export function describeError(err, A = {}) {
  if (is(err, A.APIUserAbortError) || err?.name === 'AbortError') {
    return { kind: 'aborted', title: 'Stopped', message: 'You stopped this reply.' };
  }
  if (is(err, A.AuthenticationError)) {
    return {
      kind: 'auth',
      status: 401,
      title: 'API key rejected',
      message: 'Anthropic rejected this API key (401). Check it, or paste a new one, in Settings → Assistant.',
    };
  }
  if (is(err, A.PermissionDeniedError)) {
    return {
      kind: 'permission',
      status: 403,
      title: 'Not allowed',
      message: `This API key isn't allowed to do that (403).${err.apiMessage ? ` Anthropic says: ${err.apiMessage}` : ' Check your organization and workspace settings in the Claude Console.'}`,
    };
  }
  if (is(err, A.RateLimitError)) {
    const retryAfter = parseRetryAfter(err.headers);
    return {
      kind: 'rateLimit',
      status: 429,
      retryAfter,
      title: 'Rate limited',
      message: `Your API key hit its rate limit (429). ${retryAfter ? `Try again in ${retryAfter} s.` : 'Wait a moment and try again.'}`,
    };
  }
  if (is(err, A.APIConnectionTimeoutError)) {
    return { kind: 'timeout', title: 'Timed out', message: 'The request to Anthropic timed out. Check your connection and try again.' };
  }
  if (is(err, A.APIConnectionError)) {
    return {
      kind: 'connection',
      title: "Couldn't reach Anthropic",
      message: "Couldn't reach api.anthropic.com. Check your connection; a firewall, VPN or browser extension may be blocking it.",
    };
  }
  if (is(err, A.APIError) || (err && typeof err.status === 'number')) {
    const status = err.status;
    const type = err.type || err.error?.error?.type || null;
    const said = err.apiMessage || err.error?.error?.message || '';
    if (status === 529 || type === 'overloaded_error') {
      return { kind: 'overloaded', status, title: 'Anthropic is busy', message: 'Anthropic is overloaded right now (529). Try again in a minute.' };
    }
    if (status === 402 || type === 'billing_error') {
      return { kind: 'billing', status, title: 'Billing problem', message: 'There is a billing problem on your Anthropic account (402). Check Plans & Billing in the Claude Console.' };
    }
    if (status === 404 || type === 'not_found_error') {
      return { kind: 'notFound', status, title: 'Model not available', message: `This model isn't available to your API key (404). Pick another model in Settings → Assistant.${said ? ` (${said})` : ''}` };
    }
    if (status === 413 || type === 'request_too_large') {
      return { kind: 'tooLarge', status, title: 'Too much text', message: 'That request is too large (413). Include fewer messages or start a new chat.' };
    }
    if (status === 400 || type === 'invalid_request_error') {
      return { kind: 'badRequest', status, title: 'Request rejected', message: `Anthropic rejected the request (400)${said ? `: ${said}` : '.'}` };
    }
    if (typeof status === 'number' && status >= 500) {
      return { kind: 'server', status, title: 'Anthropic error', message: `Anthropic had a problem answering (${status}). Try again in a moment.` };
    }
    return { kind: 'api', status, title: 'API error', message: `The Claude API returned an error${status ? ` (${status})` : ''}${said ? `: ${said}` : '.'}` };
  }
  const msg = String(err?.message || '');
  if (/dynamically imported module|Importing a module script failed|Loading chunk/i.test(msg)) {
    return { kind: 'load', title: "Couldn't load the assistant", message: "Couldn't load the assistant code. Check your connection and reload the page." };
  }
  return { kind: 'other', title: 'Something went wrong', message: msg || 'Something went wrong.' };
}

/**
 * A finished reply's stop_reason -> { status, note }.
 * status: done | cut | refusal (notes are shown under the reply).
 */
export function stopInfo(stopReason, stopDetails) {
  if (stopReason === 'refusal') {
    const cat = typeof stopDetails?.category === 'string' && /^[a-z_]{1,40}$/.test(stopDetails.category) ? stopDetails.category.replace(/_/g, ' ') : '';
    return {
      status: 'refusal',
      note: `Claude declined this request${cat ? ` (${cat} safety policy)` : ''}. Try rephrasing it or asking something else.`,
    };
  }
  if (stopReason === 'max_tokens') {
    return { status: 'cut', note: 'This reply was cut off because it reached the length limit.' };
  }
  if (stopReason === 'model_context_window_exceeded') {
    return { status: 'cut', note: 'This reply was cut off because the conversation is too long. Start a new chat.' };
  }
  return { status: 'done', note: '' };
}
