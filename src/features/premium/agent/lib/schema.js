// Tool definitions for the agentic coding mode and a validator for the inputs Claude sends.
//
// The requests stream with `eager_input_streaming: true` on every tool, so the API does not buffer or
// validate tool inputs: the SDK's tolerant parser can hand back a truncated or malformed object. Every
// parsed input is therefore checked here against the tool's own schema before anything runs, and a
// failure goes back to Claude as an `is_error` tool_result (see loop.js). Pure: no DOM, no Firebase.

/** Longest path a workspace accepts (src/lib/collab/workspace.js validatePath). */
export const MAX_PATH = 300;
/** Longest file body a tool may write in one call (the collab layer rejects inserts over ~900 KB). */
export const MAX_CONTENT = 800_000;
/** Longest search query. */
export const MAX_QUERY = 200;

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const int = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const bool = (description) => ({ type: 'boolean', description });

function tool(name, description, properties, required, write = false) {
  return {
    def: {
      name,
      description,
      eager_input_streaming: true,
      input_schema: { type: 'object', properties, required, additionalProperties: false },
    },
    write,
  };
}

const PATH = str('Workspace-relative file path, for example "src/app.js". No leading slash, no "." or ".." segments.', { maxLength: MAX_PATH });

const TOOLS = [
  tool('list_files', 'List every file in the workspace (paths only, sorted).', {}, []),
  tool(
    'read_file',
    'Read a file. Returns the text with line numbers ("12| code"). Use start_line/end_line (1-based, inclusive) for large files.',
    { path: PATH, start_line: int('First line to return (1-based).', { minimum: 1 }), end_line: int('Last line to return (inclusive).', { minimum: 1 }) },
    ['path'],
  ),
  tool(
    'search_files',
    'Search the text of every file. Returns "path:line: text" for each matching line (at most 200).',
    {
      query: str('Text to find, or a JavaScript regular expression when regex is true.', { maxLength: MAX_QUERY }),
      regex: bool('Treat query as a regular expression (default false).'),
      case_sensitive: bool('Match case exactly (default false).'),
      path_prefix: str('Only search files whose path starts with this (for example "src/").', { maxLength: MAX_PATH }),
    },
    ['query'],
  ),
  tool(
    'create_file',
    'Create a new file with the given content. Fails if the path already exists.',
    { path: PATH, content: str('The whole file content.', { maxLength: MAX_CONTENT }) },
    ['path', 'content'],
    true,
  ),
  tool(
    'edit_file',
    'Replace one exact snippet in a file. old_str must appear exactly once in the file (include enough surrounding lines to make it unique); it is replaced by new_str. Read the file first.',
    {
      path: PATH,
      old_str: str('The exact text to replace, including whitespace and indentation.', { maxLength: MAX_CONTENT }),
      new_str: str('The replacement text (may be empty to delete old_str).', { maxLength: MAX_CONTENT }),
    },
    ['path', 'old_str', 'new_str'],
    true,
  ),
  tool(
    'write_file',
    'Replace the whole content of an existing file. Prefer edit_file for small changes.',
    { path: PATH, content: str('The new whole file content.', { maxLength: MAX_CONTENT }) },
    ['path', 'content'],
    true,
  ),
  tool('delete_file', 'Delete a file from the workspace.', { path: PATH }, ['path'], true),
  tool(
    'rename_file',
    'Rename or move a file. Fails if new_path already exists.',
    { path: PATH, new_path: { ...PATH, description: 'The new workspace-relative path.' } },
    ['path', 'new_path'],
    true,
  ),
  tool(
    'preview',
    'Bundle an HTML (or JS / Markdown / SVG) entry file with the workspace files it references and run it for a few seconds in an isolated sandbox with no network. Returns the console output and uncaught errors. Without entry, the workspace picks index.html or the first HTML file.',
    { entry: { ...PATH, description: 'Entry file to run (optional).' } },
    [],
  ),
];

/** Names of the tools that change files (each one needs approval unless "Apply automatically" is on). */
export const WRITE_TOOLS = Object.freeze(TOOLS.filter((t) => t.write).map((t) => t.def.name));
export const TOOL_NAMES = Object.freeze(TOOLS.map((t) => t.def.name));

/**
 * The `tools` array for a request. Read-only members only get the reading tools; `preview` is left
 * out when the page can't run one (unit tests, no DOM).
 */
export function toolDefs({ readOnly = false, preview = true } = {}) {
  return TOOLS.filter((t) => (!readOnly || !t.write) && (preview || t.def.name !== 'preview')).map((t) => t.def);
}

const SCHEMAS = new Map(TOOLS.map((t) => [t.def.name, t.def.input_schema]));

function typeOk(type, v) {
  if (type === 'string') return typeof v === 'string';
  if (type === 'integer') return Number.isInteger(v);
  if (type === 'boolean') return typeof v === 'boolean';
  return false;
}

/**
 * Check a parsed tool input against the tool's schema (the subset these tools use: an object of
 * string / integer / boolean fields, required, additionalProperties false, maxLength, minimum).
 * Returns '' when valid, else a short reason.
 */
export function validateInput(name, input) {
  const schema = SCHEMAS.get(name);
  if (!schema) return `Unknown tool "${String(name).slice(0, 64)}".`;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'The input must be a JSON object.';
  for (const key of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) return `Unexpected field "${key.slice(0, 64)}".`;
  }
  for (const key of schema.required) {
    if (!Object.prototype.hasOwnProperty.call(input, key) || input[key] === undefined || input[key] === null) return `Missing required field "${key}".`;
  }
  for (const [key, spec] of Object.entries(schema.properties)) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const v = input[key];
    if (!typeOk(spec.type, v)) return `Field "${key}" must be a${spec.type === 'integer' ? 'n' : ''} ${spec.type}.`;
    if (spec.maxLength !== undefined && v.length > spec.maxLength) return `Field "${key}" is too long (max ${spec.maxLength} characters).`;
    if (spec.minimum !== undefined && v < spec.minimum) return `Field "${key}" must be at least ${spec.minimum}.`;
  }
  return '';
}
