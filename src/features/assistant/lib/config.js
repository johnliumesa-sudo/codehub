// Assistant constants: models, effort levels, languages, request limits. Pure (no DOM, no React), so
// the unit tests import it directly.

/** The model picker. Exact ids, never date-suffixed. The first one is the default. */
export const MODELS = Object.freeze([
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', hint: 'Most capable (default)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', hint: 'Fast and capable' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', hint: 'Fastest, lowest cost' },
]);
export const DEFAULT_MODEL = MODELS[0].id;

/** Models that get the server-side refusal fallback (`fallbacks: 'default'`). Not Haiku. */
export const FALLBACK_MODELS = Object.freeze(['claude-opus-5-5', 'claude-sonnet-5-5']);
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** `output_config.effort` choices. `low` keeps chat replies quick. */
export const EFFORTS = Object.freeze([
  { id: 'low', label: 'Low', hint: 'Quickest replies (default)' },
  { id: 'medium', label: 'Medium', hint: 'More thorough' },
  { id: 'high', label: 'High', hint: 'Most thorough, slowest' },
]);
export const DEFAULT_EFFORT = 'low';

/** max_tokens for every streamed request. */
export const STREAM_MAX_TOKENS = 64000;
/** max_tokens for the non-streamed "Test key" request. */
export const TEST_MAX_TOKENS = 64;

/** "Include last N messages" choices in the panel and for "Draft a reply". */
export const CONTEXT_COUNTS = Object.freeze([10, 20, 50, 100]);
export const DEFAULT_CONTEXT_COUNT = 20;

/** Catch me up scopes. */
export const CATCHUP_SCOPES = Object.freeze([
  { id: 'unread', label: 'Unread' },
  { id: 'last50', label: 'Last 50', count: 50 },
  { id: 'last100', label: 'Last 100', count: 100 },
  { id: 'last200', label: 'Last 200', count: 200 },
]);
/** Most messages a catch-up or summary ever reads. */
export const MAX_SUMMARY_MESSAGES = 200;

/** Characters of chat transcript sent with one request (oldest lines are dropped first). */
export const MAX_TRANSCRIPT_CHARS = 120_000;
/** Characters of a single chat message inside a transcript. */
export const MAX_MESSAGE_CHARS = 4_000;
/** Characters of a question typed into the panel. */
export const MAX_QUESTION_CHARS = 20_000;

/** Translation targets (English names are what the prompt uses). */
export const LANGUAGES = Object.freeze([
  ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'],
  ['pt', 'Portuguese'], ['nl', 'Dutch'], ['sv', 'Swedish'], ['pl', 'Polish'], ['uk', 'Ukrainian'],
  ['ru', 'Russian'], ['tr', 'Turkish'], ['ar', 'Arabic'], ['he', 'Hebrew'], ['hi', 'Hindi'],
  ['bn', 'Bengali'], ['id', 'Indonesian'], ['vi', 'Vietnamese'], ['th', 'Thai'], ['zh', 'Chinese (Simplified)'],
  ['zh-TW', 'Chinese (Traditional)'], ['ja', 'Japanese'], ['ko', 'Korean'],
]);

/** Language name for a BCP 47 tag (navigator.language), English when unknown. */
export function languageFor(tag) {
  const t = String(tag || '').trim();
  if (!t) return 'English';
  const exact = LANGUAGES.find(([code]) => code.toLowerCase() === t.toLowerCase());
  if (exact) return exact[1];
  if (/^zh-(tw|hk|mo|hant)/i.test(t)) return 'Chinese (Traditional)';
  const base = t.split(/[-_]/)[0].toLowerCase();
  return LANGUAGES.find(([code]) => code === base)?.[1] || 'English';
}

export const isModel = (id) => MODELS.some((m) => m.id === id);
export const isEffort = (id) => EFFORTS.some((e) => e.id === id);
export const isLanguage = (name) => LANGUAGES.some(([, n]) => n === name);
export const modelLabel = (id) => MODELS.find((m) => m.id === id)?.label || String(id || '');

/** Preferences kept in localStorage (never in the database). */
export function defaultPrefs(navLang) {
  return {
    model: DEFAULT_MODEL,
    effort: DEFAULT_EFFORT,
    lang: languageFor(navLang),
    ctxCount: DEFAULT_CONTEXT_COUNT,
    draftContext: false,
  };
}

/** Merge stored prefs over the defaults, dropping anything invalid. */
export function cleanPrefs(raw, navLang) {
  const out = defaultPrefs(navLang);
  if (!raw || typeof raw !== 'object') return out;
  if (isModel(raw.model)) out.model = raw.model;
  if (isEffort(raw.effort)) out.effort = raw.effort;
  if (isLanguage(raw.lang)) out.lang = raw.lang;
  if (CONTEXT_COUNTS.includes(raw.ctxCount)) out.ctxCount = raw.ctxCount;
  if (typeof raw.draftContext === 'boolean') out.draftContext = raw.draftContext;
  return out;
}
