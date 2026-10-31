// Language detection by file extension -> CodeMirror language extension + labels.
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { java } from '@codemirror/lang-java';
import { cpp } from '@codemirror/lang-cpp';
import { rust } from '@codemirror/lang-rust';

const LANGS = {
  js: { label: 'JavaScript', fence: 'js', color: '#f5c542', load: () => javascript({ jsx: true }) },
  jsx: { label: 'JSX', fence: 'jsx', color: '#2bc4d9', load: () => javascript({ jsx: true }) },
  ts: { label: 'TypeScript', fence: 'ts', color: '#5b8cff', load: () => javascript({ typescript: true }) },
  tsx: { label: 'TSX', fence: 'tsx', color: '#5b8cff', load: () => javascript({ typescript: true, jsx: true }) },
  py: { label: 'Python', fence: 'python', color: '#3ccf91', load: () => python() },
  html: { label: 'HTML', fence: 'html', color: '#ff8f4d', load: () => html() },
  css: { label: 'CSS', fence: 'css', color: '#a66bff', load: () => css() },
  json: { label: 'JSON', fence: 'json', color: '#f5c542', load: () => json() },
  md: { label: 'Markdown', fence: 'markdown', color: '#9aa3b5', load: () => markdown() },
  java: { label: 'Java', fence: 'java', color: '#ff6b9a', load: () => java() },
  cpp: { label: 'C++', fence: 'cpp', color: '#5b8cff', load: () => cpp() },
  c: { label: 'C', fence: 'c', color: '#8892a6', load: () => cpp() },
  rust: { label: 'Rust', fence: 'rust', color: '#ff8f4d', load: () => rust() },
};

const EXT = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx',
  ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'tsx',
  py: 'py', pyw: 'py',
  html: 'html', htm: 'html', vue: 'html', svelte: 'html', xml: 'html', svg: 'html',
  css: 'css', scss: 'css', less: 'css',
  json: 'json', jsonc: 'json', webmanifest: 'json',
  md: 'md', markdown: 'md', mdx: 'md',
  java: 'java', kt: 'java',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  rs: 'rust',
};

const PLAIN = { id: 'text', label: 'Plain text', fence: '', color: '#6b7487', load: () => [] };

export function fileExt(path) {
  const name = String(path || '').split('/').pop();
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** -> { id, label, fence, color, load(): Extension } */
export function languageFor(path) {
  const id = EXT[fileExt(path)];
  return id ? { id, ...LANGS[id] } : PLAIN;
}
