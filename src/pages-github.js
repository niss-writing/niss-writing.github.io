import { parseSubmissionMarkdown, renderSubmissionMarkdown, validatePdf, MAX_MARKDOWN_BYTES } from './validation.js';

const API = 'https://api.github.com';
const BRANCH = 'submission';
const PATHS = ['submission.md', 'cv.pdf', 'sample.pdf'];
const PDF_LIMIT = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export class PagesStoreError extends Error {
  constructor(status, code, message, githubStatus) {
    super(message);
    this.name = 'PagesStoreError';
    this.status = status;
    this.code = code;
    if (githubStatus) this.githubStatus = githubStatus;
  }
}
const conflict = (message = 'This submission changed in another tab. Reload it before saving again.') => new PagesStoreError(409, 'submission_conflict', message);
const guard = (message) => new PagesStoreError(409, 'repository_guard', message);
const equalName = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

function base64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(binary);
}
function decode64(value, limit) {
  if (typeof value !== 'string' || value.length > Math.ceil(limit / 3) * 4 + 65536) throw guard('A saved file is larger than the permitted size.');
  const text = value.replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4) throw guard('A saved file has an invalid encoding.');
  let binary;
  try { binary = atob(text); } catch { throw guard('A saved file has an invalid encoding.'); }
  if (binary.length > limit) throw guard('A saved file is larger than the permitted size.');
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
async function hash(bytes, algorithm) {
  return [...new Uint8Array(await crypto.subtle.digest(algorithm, bytes))].map((x) => x.toString(16).padStart(2, '0')).join('');
}
async function blobHash(bytes) {
  const header = encoder.encode(`blob ${bytes.length}\0`);
  const combined = new Uint8Array(header.length + bytes.length);
  combined.set(header);
  combined.set(bytes, header.length);
  return hash(combined, 'SHA-1');
}
function sameBytes(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function sameIntent(a, b) {
  return a.id === b.id && a.requestId === b.requestId && a.editKeyHash === b.editKeyHash
    && JSON.stringify(a.data) === JSON.stringify(b.data) && JSON.stringify(a.files) === JSON.stringify(b.files)
    && sameBytes(a.pdfBytes.cv, b.pdfBytes.cv) && sameBytes(a.pdfBytes.sample, b.pdfBytes.sample);
}

/**
 * Browser-only transport. The organizer-issued, single-repository credential is
 * retained only in this closure and sent only to api.github.com. No localStorage,
 * URL, analytics, server proxy, repository provisioning, or merge endpoint is used.
 * A separate trusted Action validates and merges the resulting private PR.
 */
export function createPagesStore({ owner, repo, token, id, fetchImpl = fetch }) {
  if (typeof owner !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)
    || typeof repo !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(repo)
    || typeof id !== 'string' || !UUID.test(id)) {
    throw new PagesStoreError(400, 'connection_invalid', 'Open the complete connection link supplied by the organizer.');
  }
  if (typeof token !== 'string' || !/^github_pat_[A-Za-z0-9_]{20,}$/.test(token.trim())) {
    throw new PagesStoreError(401, 'authentication', 'Use the fine-grained submission credential supplied by the organizer.');
  }
  let credential = token.trim();
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const fullName = `${owner}/${repo}`;
  const identityHash = hash(encoder.encode(id), 'SHA-256');
  const treeCache = new Map();
  let repositoryId;

  async function api(suffix, { method = 'GET', body, allow404 = false } = {}) {
    if (!credential) throw new PagesStoreError(401, 'authentication', 'Reconnect using your submission credential.');
    let response;
    try {
      response = await fetchImpl(`${API}${path}${suffix}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${credential}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw new PagesStoreError(503, 'github_unavailable', 'The connection was interrupted. Retry the same submission to recover safely.');
    }
    if (allow404 && response.status === 404) return null;
    if (!response.ok) {
      const status = response.status;
      const message = [401, 403].includes(status)
        ? 'The submission credential was not accepted. It may need organizer approval, replacement, or access to this repository.'
        : status === 404 ? 'This private submission repository is unavailable. Check your connection details with the organizer.'
          : 'GitHub could not finish this operation. Retry the same submission or contact the organizer.';
      throw new PagesStoreError([401, 403, 404].includes(status) ? status : 503,
        [401, 403].includes(status) ? 'authentication' : status === 404 ? 'repository_missing' : 'github_error', message, status);
    }
    if (response.status === 204) return null;
    try { return await response.json(); } catch { throw new PagesStoreError(503, 'github_response', 'GitHub returned an unreadable response. Retry the same submission.'); }
  }

  async function repository() {
    const result = await api('');
    if (result.private !== true || !equalName(result.owner?.login, owner) || !equalName(result.name, repo)
      || !equalName(result.full_name, fullName) || !Number.isSafeInteger(result.id) || result.id <= 0
      || result.default_branch !== 'main' || result.archived || result.disabled || result.fork
      || (repositoryId !== undefined && result.id !== repositoryId)) {
      throw guard('This is not the expected active private submission repository.');
    }
    repositoryId = result.id;
    return result;
  }
  async function ref(branch, optional = false) {
    const result = await api(`/git/ref/heads/${encodeURIComponent(branch)}`, { allow404: optional });
    if (result === null) return null;
    if (result.ref !== `refs/heads/${branch}` || result.object?.type !== 'commit' || !SHA.test(result.object.sha ?? '')) throw guard('GitHub returned an unexpected branch.');
    return result.object.sha;
  }
  async function tree(commitSHA) {
    if (!SHA.test(commitSHA ?? '')) throw guard('A saved version has an invalid identifier.');
    if (treeCache.has(commitSHA)) return treeCache.get(commitSHA);
    const commit = await api(`/git/commits/${commitSHA}`);
    if (commit.sha !== commitSHA || !SHA.test(commit.tree?.sha ?? '')) throw guard('GitHub returned an unexpected commit.');
    const result = await api(`/git/trees/${commit.tree.sha}?recursive=1`);
    if (result.sha !== commit.tree.sha || result.truncated !== false || !Array.isArray(result.tree) || result.tree.length > 1000) throw guard('The complete saved submission could not be inspected.');
    const entries = new Map();
    for (const item of result.tree) {
      if (typeof item.path !== 'string' || entries.has(item.path) || !SHA.test(item.sha ?? '')) throw guard('A saved repository tree is invalid.');
      entries.set(item.path, item);
    }
    const value = { sha: result.sha, entries };
    treeCache.set(commitSHA, value);
    return value;
  }
  async function file(at, filename, limit) {
    const entry = at.entries.get(filename);
    if (!entry || entry.type !== 'blob' || entry.mode !== '100644' || !Number.isSafeInteger(entry.size) || entry.size <= 0 || entry.size > limit) throw guard('A saved file has an unexpected path, type, or size.');
    const blob = await api(`/git/blobs/${entry.sha}`);
    if (blob.sha !== entry.sha || blob.encoding !== 'base64') throw guard('GitHub returned an unexpected saved file.');
    const bytes = decode64(blob.content, limit);
    if (bytes.length !== entry.size || await blobHash(bytes) !== entry.sha) throw guard('Saved file bytes do not match their commit.');
    return bytes;
  }
  async function manifest(at, information) {
    let value;
    try { value = JSON.parse(decoder.decode(await file(at, '.submission-config.json', 8192))); }
    catch { throw guard('The organizer has not initialized this repository for this submission.'); }
    const keys = ['schemaVersion', 'id', 'repositoryId', 'owner', 'name', 'defaultBranch'];
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length
      || !keys.every((key) => Object.hasOwn(value, key)) || value.schemaVersion !== 2 || value.id !== id
      || value.repositoryId !== information.id || !equalName(value.owner, owner) || !equalName(value.name, repo)
      || value.defaultBranch !== 'main') throw guard('The saved repository identity does not match your connection link.');
  }
  async function recordAt(commitSHA, at) {
    const count = PATHS.filter((filename) => at.entries.has(filename)).length;
    if (count === 0) return null;
    if (count !== PATHS.length) throw guard('The saved submission is incomplete.');
    let markdown, metadata;
    try {
      markdown = decoder.decode(await file(at, 'submission.md', MAX_MARKDOWN_BYTES));
      metadata = parseSubmissionMarkdown(markdown);
    } catch { throw guard('The saved submission information could not be verified.'); }
    if (metadata.id !== id || metadata.editKeyHash !== await identityHash) throw guard('The saved submission belongs to a different connection link.');
    const cv = await file(at, 'cv.pdf', PDF_LIMIT);
    const sample = await file(at, 'sample.pdf', PDF_LIMIT);
    if (metadata.files.cv.bytes !== cv.length || metadata.files.sample.bytes !== sample.length) throw guard('Saved document sizes do not match the information record.');
    return { ...metadata, markdown, pdfBytes: { cv, sample }, version: commitSHA };
  }
  function validatePR(value, information, headSHA) {
    if (!value || !Number.isSafeInteger(value.number) || value.number < 1
      || value.head?.ref !== BRANCH || value.base?.ref !== 'main'
      || value.head?.repo?.id !== information.id || value.base?.repo?.id !== information.id
      || value.head.repo.private !== true || value.base.repo.private !== true
      || !equalName(value.head.repo.full_name, fullName) || !equalName(value.base.repo.full_name, fullName)
      || (headSHA !== undefined && value.head.sha !== headSHA)) throw guard('The saved pull request does not match this submission.');
  }
  async function pulls(information) {
    const query = new URLSearchParams({ state: 'all', head: `${owner}:${BRANCH}`, base: 'main', sort: 'updated', direction: 'desc', per_page: '100' });
    const list = await api(`/pulls?${query}`);
    if (!Array.isArray(list)) throw guard('GitHub returned an invalid pull-request list.');
    for (const value of list) validatePR(value, information);
    if (list.filter((value) => value.state === 'open').length > 1) throw guard('More than one pending submission exists. Contact the organizer.');
    return list;
  }
  function receipt(record, status, pr) {
    return { status, reference: id.slice(0, 8).toUpperCase(), updatedAt: record.submittedAt,
      pullRequestNumber: pr?.number ?? null,
      pullRequestUrl: pr ? `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pull/${pr.number}` : null };
  }
  async function snapshot() {
    const information = await repository();
    const baseSHA = await ref('main');
    const branchSHA = await ref(BRANCH, true);
    const baseTree = await tree(baseSHA);
    await manifest(baseTree, information);
    const baseRecord = await recordAt(baseSHA, baseTree);
    const list = await pulls(information);
    const openPR = list.find((value) => value.state === 'open');
    let branchRecord = null;
    if (branchSHA) {
      const branchTree = await tree(branchSHA);
      const sameFiles = baseRecord && PATHS.every((filename) => branchTree.entries.get(filename)?.sha === baseTree.entries.get(filename)?.sha
        && branchTree.entries.get(filename)?.mode === '100644');
      branchRecord = sameFiles ? { ...baseRecord, version: branchSHA } : await recordAt(branchSHA, branchTree);
      if (baseRecord && branchRecord && baseRecord.requestId === branchRecord.requestId && !sameFiles) throw guard('The same request has conflicting saved contents.');
    }
    if (openPR && (!branchRecord || openPR.head.sha !== branchSHA)) throw conflict('The pending submission changed while loading. Reload and try again.');
    const staged = Boolean(branchRecord && (openPR || !baseRecord || branchRecord.requestId !== baseRecord.requestId));
    const current = staged ? branchRecord : baseRecord;
    if (current) {
      const pr = staged ? (openPR || list.find((value) => value.head.sha === branchSHA))
        : list.find((value) => value.merged_at && value.head.sha === branchSHA);
      current.receipt = receipt(current, staged ? 'pending' : 'merged', pr);
    }
    return { information, baseSHA, branchSHA, baseTree, current, staged, openPR, list };
  }
  async function ensurePR(state, record) {
    await repository();
    if (await ref(BRANCH) !== record.version) throw conflict();
    let list = await pulls(state.information);
    let pr = list.find((value) => value.state === 'open');
    const completed = list.find((value) => value.merged_at && value.head.sha === record.version);
    if (!pr && completed) {
      if (!SHA.test(completed.merge_commit_sha ?? '')) {
        const loaded = await snapshot();
        if (!loaded.current || loaded.current.requestId !== record.requestId || loaded.staged) throw conflict();
        return { record: loaded.current, receipt: loaded.current.receipt };
      }
      const saved = { ...record, version: completed.merge_commit_sha };
      saved.receipt = receipt(saved, 'merged', completed);
      return { record: saved, receipt: saved.receipt };
    }
    if (!pr) {
      try {
        pr = await api('/pulls', { method: 'POST', body: {
          title: 'Submission update', body: 'A submission record and two PDF documents. Automated validation is required before merging.',
          head: BRANCH, base: 'main', maintainer_can_modify: false,
        } });
      } catch (error) {
        if (error.githubStatus !== 422) throw error;
        list = await pulls(state.information);
        pr = list.find((value) => value.state === 'open');
        if (!pr) throw error;
      }
    }
    validatePR(pr, state.information, record.version);
    const saved = { ...record, receipt: receipt(record, 'pending', pr) };
    return { record: saved, receipt: saved.receipt };
  }

  async function load() { return (await snapshot()).current; }

  async function save(input, { expectedVersion = '', requestId } = {}) {
    if (!input || input.id !== id || input.requestId !== requestId || !UUID.test(requestId ?? '')
      || (expectedVersion && !SHA.test(expectedVersion)) || input.editKeyHash !== await identityHash
      || !(input.pdfBytes?.cv instanceof Uint8Array) || !(input.pdfBytes?.sample instanceof Uint8Array)) {
      throw new PagesStoreError(400, 'invalid_record', 'The submission information is incomplete. Reload and try again.');
    }
    const markdown = renderSubmissionMarkdown(input);
    const record = { ...parseSubmissionMarkdown(markdown), markdown, pdfBytes: input.pdfBytes };
    for (const kind of ['cv', 'sample']) {
      const checked = await validatePdf(record.pdfBytes[kind], record.files[kind].name, { maxBytes: PDF_LIMIT, maxPages: 100, label: kind === 'cv' ? 'CV' : 'Sample' });
      if (JSON.stringify(checked.info) !== JSON.stringify(record.files[kind])) throw new PagesStoreError(400, 'invalid_record', 'A document does not match its saved information.');
    }
    let state = await snapshot();
    if (state.current?.requestId === requestId) {
      if (!sameIntent(state.current, record)) throw conflict('This request ID was already used for different answers or documents. Start a new save attempt.');
      return state.staged ? ensurePR(state, state.current) : { record: state.current, receipt: state.current.receipt };
    }
    if ((state.current?.version || '') !== expectedVersion) throw conflict();
    if (state.current && state.current.createdAt !== record.createdAt) throw conflict('The original submission creation date cannot change.');
    const entries = [];
    for (const [filename, bytes] of [['submission.md', encoder.encode(markdown)], ['cv.pdf', record.pdfBytes.cv], ['sample.pdf', record.pdfBytes.sample]]) {
      const blob = await api('/git/blobs', { method: 'POST', body: { content: base64(bytes), encoding: 'base64' } });
      if (blob.sha !== await blobHash(bytes)) throw guard('Uploaded bytes do not match their returned file identifier.');
      entries.push({ path: filename, mode: '100644', type: 'blob', sha: blob.sha });
    }
    const newTree = await api('/git/trees', { method: 'POST', body: { base_tree: state.baseTree.sha, tree: entries } });
    if (!SHA.test(newTree.sha ?? '')) throw guard('GitHub returned an invalid submission tree.');
    const commit = await api('/git/commits', { method: 'POST', body: {
      message: 'Update submission', tree: newTree.sha, parents: [...new Set([state.branchSHA, state.baseSHA].filter(Boolean))],
    } });
    if (!SHA.test(commit.sha ?? '')) throw guard('GitHub returned an invalid submission commit.');
    await repository();
    if (await ref('main') !== state.baseSHA || await ref(BRANCH, true) !== state.branchSHA) throw conflict();
    try {
      if (state.branchSHA) await api(`/git/refs/heads/${BRANCH}`, { method: 'PATCH', body: { sha: commit.sha, force: false } });
      else await api('/git/refs', { method: 'POST', body: { ref: `refs/heads/${BRANCH}`, sha: commit.sha } });
    } catch (error) {
      if (![409, 422].includes(error.githubStatus)) throw error;
      const latest = await snapshot();
      if (latest.current?.requestId === requestId && sameIntent(latest.current, record)) {
        return latest.staged ? ensurePR(latest, latest.current) : { record: latest.current, receipt: latest.current.receipt };
      }
      throw conflict();
    }
    return ensurePR(state, { ...record, version: commit.sha });
  }

  return { load, save, disconnect() { credential = ''; treeCache.clear(); } };
}
