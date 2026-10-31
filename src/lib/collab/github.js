// Minimal GitHub REST client (browser fetch). The token, if any, is the user's PAT from their
// encrypted vault (keystore.loadGithubToken) and is only ever sent to api.github.com.
const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

// Every value below can come from data another server member controls (the linked repo, file
// paths in decrypted file meta), and requests carry the *viewer's* token. Validate strictly so a
// crafted value can never redirect a request to a different API endpoint (e.g. via `..`, `/`, `?`).
const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;

export function isValidRepoName(s) {
  return typeof s === 'string' && NAME_RE.test(s) && s !== '.' && s !== '..';
}

// git check-ref-format, roughly: no empty/dot segments, no '..', no control chars or ~^:?*[\ ,
// no '@{', no trailing '.lock' / '/' / '.'.
export function isValidBranchName(s) {
  if (typeof s !== 'string' || !s || s.length > 255) return false;
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(s) || s.includes('..') || s.includes('@{') || s === '@') return false;
  if (s.startsWith('/') || s.endsWith('/') || s.endsWith('.') || s.endsWith('.lock') || s.includes('//')) return false;
  return s.split('/').every((part) => part && !part.startsWith('.'));
}

function repoBase(owner, repo) {
  if (!isValidRepoName(owner) || !isValidRepoName(repo)) throw new GitHubError('Invalid repository name', 400);
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

const seg = (p) => {
  const parts = String(p ?? '').split('/');
  if (parts.some((x) => x === '' || x === '.' || x === '..')) throw new GitHubError('Invalid path', 400);
  return parts.map(encodeURIComponent).join('/');
};

const shaSeg = (sha) => {
  if (typeof sha !== 'string' || !/^[0-9a-f]{40,64}$/i.test(sha)) throw new GitHubError('Invalid object id', 400);
  return sha;
};

async function gh(path, { token, method = 'GET', body } = {}) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  } catch {
    throw new GitHubError('Network error talking to GitHub', 0);
  }
  if (res.status === 204) return null;
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  if (!res.ok) {
    let msg = data?.message || `GitHub request failed (${res.status})`;
    if (res.status === 401) msg = 'GitHub rejected the token. Update it in Settings.';
    else if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')
      msg = token ? 'GitHub rate limit reached. Try again later.' : 'GitHub rate limit reached. Add a token in Settings for higher limits.';
    else if (res.status === 404) msg = token ? 'Not found (or your token lacks access).' : 'Not found. Private repos need a GitHub token (Settings).';
    else if (Array.isArray(data?.errors) && data.errors[0]?.message) msg += `: ${data.errors[0].message}`;
    throw new GitHubError(msg, res.status);
  }
  return data;
}

// ---------- base64 <-> utf8 ----------

export function utf8ToB64(text) {
  const bytes = new TextEncoder().encode(text);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function b64ToBytes(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeText(b64) {
  const bytes = b64ToBytes(b64);
  if (bytes.subarray(0, 8000).includes(0)) throw new GitHubError('Binary files can’t be opened in the editor', 415);
  return new TextDecoder().decode(bytes);
}

// ---------- API ----------

export function parseRepo(input) {
  const s = String(input || '').trim().replace(/\.git$/, '');
  const m = s.match(/(?:github\.com[/:])?([\w.-]+)\/([\w.-]+)\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

export const getUser = (token) => gh('/user', { token });

export const getRepo = (owner, repo, token) => gh(repoBase(owner, repo), { token });

export async function listBranches(owner, repo, token) {
  return gh(`${repoBase(owner, repo)}/branches?per_page=100`, { token });
}

/** Recursive tree for a branch/sha -> { entries: [{path, type:'blob'|'tree', sha, size}], truncated } */
export async function getTree(owner, repo, refName, token) {
  const data = await gh(`${repoBase(owner, repo)}/git/trees/${encodeURIComponent(refName)}?recursive=1`, { token });
  return {
    entries: (data.tree || []).filter((e) => e.type === 'blob' || e.type === 'tree'),
    truncated: !!data.truncated,
  };
}

/** File content at a ref. -> { text, sha } or null if the file doesn't exist there. */
export async function getFile(owner, repo, path, refName, token) {
  let data;
  try {
    data = await gh(`${repoBase(owner, repo)}/contents/${seg(path)}?ref=${encodeURIComponent(refName)}`, { token });
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
  if (Array.isArray(data) || data.type !== 'file') throw new GitHubError('That path is not a file', 400);
  if (data.content && data.encoding === 'base64') return { text: decodeText(data.content), sha: data.sha };
  // > 1 MB: content omitted, use the blob API.
  return { text: await getBlobText(owner, repo, data.sha, token), sha: data.sha };
}

export async function getBlobText(owner, repo, sha, token) {
  const blob = await gh(`${repoBase(owner, repo)}/git/blobs/${shaSeg(sha)}`, { token });
  return decodeText(blob.content);
}

/** Create or update a file. -> { contentSha, commitSha, commitUrl } */
export async function putFile(owner, repo, { path, text, message, branch, sha }, token) {
  const body = { message, content: utf8ToB64(text), branch };
  if (sha) body.sha = sha;
  const data = await gh(`${repoBase(owner, repo)}/contents/${seg(path)}`, { token, method: 'PUT', body });
  return { contentSha: data.content?.sha, commitSha: data.commit?.sha, commitUrl: data.commit?.html_url };
}

export async function createBranch(owner, repo, fromBranch, newBranch, token) {
  const refData = await gh(`${repoBase(owner, repo)}/git/ref/heads/${seg(fromBranch)}`, { token });
  if (!isValidBranchName(newBranch)) throw new GitHubError('Invalid branch name', 400);
  return gh(`${repoBase(owner, repo)}/git/refs`, {
    token,
    method: 'POST',
    body: { ref: `refs/heads/${newBranch}`, sha: refData.object.sha },
  });
}

export function createPullRequest(owner, repo, { title, head, base, body }, token) {
  return gh(`${repoBase(owner, repo)}/pulls`, { token, method: 'POST', body: { title, head, base, body } });
}

export function listPulls(owner, repo, token) {
  return gh(`${repoBase(owner, repo)}/pulls?state=open&per_page=30`, { token });
}

export async function listIssues(owner, repo, token) {
  const items = await gh(`${repoBase(owner, repo)}/issues?state=open&per_page=30`, { token });
  return (items || []).filter((i) => !i.pull_request);
}
