import { createHash } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseSubmissionMarkdown, validatePdf, MAX_PDF_BYTES, MAX_MARKDOWN_BYTES } from '../src/validation.js';

const API = 'https://api.github.com';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const ALLOWED_PATHS = ['submission.md', 'cv.pdf', 'sample.pdf'];
const MANIFEST = '.submission-config.json';
const sameName = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const hash = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
const blobHash = (bytes) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class SubmissionGateError extends Error {
  constructor(message, code = 'validation_failed', status) {
    super(message);
    this.name = 'SubmissionGateError';
    this.code = code;
    if (status) this.status = status;
  }
}

function requireValue(condition, message, code) {
  if (!condition) throw new SubmissionGateError(message, code);
}

/**
 * Called only from the pinned public-site checkout. Private repository files
 * are fetched as bounded bytes and parsed as data. No submitted code executes.
 */
export async function validateAndMerge(env, { fetchImpl = fetch, sleep = delay } = {}) {
  const id = env.EXPECTED_SUBMISSION_ID;
  const owner = env.EXPECTED_OWNER;
  const name = env.EXPECTED_REPOSITORY_NAME;
  const repoID = Number(env.EXPECTED_REPOSITORY_ID);
  const prNumber = Number(env.PR_NUMBER);
  const branch = env.EXPECTED_BRANCH || 'submission';
  const maximum = Number(env.MAX_FILE_BYTES || 2 * 1024 * 1024);
  const expectedHead = env.REQUEST_HEAD_SHA || null;
  requireValue(UUID.test(id || ''), 'Invalid pinned submission identity.', 'configuration');
  requireValue(/^[a-z0-9][a-z0-9-]{0,38}$/i.test(owner || '') && name === `temporary-entry-${id}`,
    'Invalid pinned repository identity.', 'configuration');
  requireValue(Number.isSafeInteger(repoID) && repoID > 0 && Number.isSafeInteger(prNumber) && prNumber > 0,
    'Invalid pinned repository or pull-request number.', 'configuration');
  requireValue(branch === 'submission' && Number.isSafeInteger(maximum) && maximum > 0 && maximum <= MAX_PDF_BYTES,
    'Invalid submission configuration.', 'configuration');
  requireValue(typeof env.GITHUB_TOKEN === 'string' && env.GITHUB_TOKEN.length > 0,
    'The GitHub Actions repository token is missing.', 'configuration');
  requireValue(env.GITHUB_REPOSITORY === `${owner}/${name}`,
    'This workflow was copied to a different repository.', 'configuration');
  requireValue(['pull_request_target', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME),
    'Unsupported workflow trigger.', 'configuration');
  requireValue(env.GITHUB_EVENT_NAME !== 'pull_request_target' || SHA.test(expectedHead || ''),
    'The triggering pull-request head is missing.', 'configuration');

  const root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const fullName = `${owner}/${name}`;
  const treeCache = new Map();

  async function api(path, { method = 'GET', body } = {}) {
    let response;
    try {
      response = await fetchImpl(`${API}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'temporary-submission-validator',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error', signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw new SubmissionGateError('GitHub could not be reached. An administrator can retry this workflow.', 'github_unavailable');
    }
    if (!response.ok) throw new SubmissionGateError(`GitHub refused the operation (HTTP ${response.status}).`, 'github_error', response.status);
    try { return await response.json(); } catch {
      throw new SubmissionGateError('GitHub returned an unreadable response.', 'github_response');
    }
  }

  async function repository() {
    const repo = await api(root);
    requireValue(repo.private === true && repo.id === repoID && sameName(repo.name, name) &&
      sameName(repo.full_name, fullName) && sameName(repo.owner?.login, owner) &&
      repo.default_branch === 'main' && !repo.archived && !repo.disabled && !repo.fork,
    'The target must remain the configured private repository.', 'repository_guard');
    return repo;
  }

  async function pull() {
    const pr = await api(`${root}/pulls/${prNumber}`);
    requireValue(pr.number === prNumber && pr.base?.ref === 'main' && pr.head?.ref === branch &&
      pr.head.repo?.id === repoID && pr.base.repo?.id === repoID &&
      pr.head.repo.private === true && pr.base.repo.private === true &&
      sameName(pr.head.repo.full_name, fullName) && sameName(pr.base.repo.full_name, fullName) &&
      SHA.test(pr.head.sha || '') && SHA.test(pr.base.sha || ''),
    'The pull request must use this private repository and its submission branch.', 'repository_guard');
    return pr;
  }

  async function ref(branchName) {
    const result = await api(`${root}/git/ref/heads/${branchName}`);
    requireValue(result.ref === `refs/heads/${branchName}` && result.object?.type === 'commit' && SHA.test(result.object.sha || ''),
      'GitHub returned an unexpected branch reference.', 'repository_guard');
    return result.object.sha;
  }

  async function tree(commitSHA) {
    if (treeCache.has(commitSHA)) return treeCache.get(commitSHA);
    const commit = await api(`${root}/git/commits/${commitSHA}`);
    requireValue(commit.sha === commitSHA && SHA.test(commit.tree?.sha || ''), 'Unexpected Git commit.', 'repository_guard');
    const result = await api(`${root}/git/trees/${commit.tree.sha}?recursive=1`);
    requireValue(result.sha === commit.tree.sha && result.truncated === false && Array.isArray(result.tree) && result.tree.length <= 1000,
      'The complete repository tree could not be inspected.', 'repository_guard');
    const entries = new Map();
    for (const entry of result.tree) {
      requireValue(typeof entry.path === 'string' && !entries.has(entry.path) && SHA.test(entry.sha || ''),
        'GitHub returned an invalid tree entry.', 'repository_guard');
      entries.set(entry.path, entry);
    }
    treeCache.set(commitSHA, entries);
    return entries;
  }

  async function file(entries, path, limit) {
    const entry = entries.get(path);
    requireValue(entry?.mode === '100644' && entry.type === 'blob' &&
      Number.isSafeInteger(entry.size) && entry.size > 0 && entry.size <= limit,
    'Submission files must be ordinary files within the allowed size limits.', 'repository_guard');
    const blob = await api(`${root}/git/blobs/${entry.sha}`);
    requireValue(blob.sha === entry.sha && blob.encoding === 'base64' && typeof blob.content === 'string' &&
      blob.content.length <= Math.ceil(limit / 3) * 4 + 65536,
    'GitHub returned an unexpected or oversized file.', 'repository_guard');
    const encoded = blob.content.replace(/\s/g, '');
    requireValue(/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) && encoded.length % 4 === 0,
      'GitHub returned an invalid file encoding.', 'repository_guard');
    const bytes = Buffer.from(encoded, 'base64');
    requireValue(bytes.length === entry.size && bytes.length <= limit && blobHash(bytes) === entry.sha,
      'File bytes do not match the inspected commit.', 'repository_guard');
    return bytes;
  }

  const expectedManifest = { schemaVersion: 2, id, repositoryId: repoID, owner, name, defaultBranch: 'main' };
  async function manifest(entries) {
    let value;
    try { value = JSON.parse((await file(entries, MANIFEST, 16384)).toString('utf8')); }
    catch (error) {
      if (error instanceof SubmissionGateError) throw error;
      throw new SubmissionGateError('The submission manifest is unreadable.', 'repository_guard');
    }
    requireValue(value && typeof value === 'object' && !Array.isArray(value) &&
      Object.keys(value).length === Object.keys(expectedManifest).length &&
      Object.entries(expectedManifest).every(([key, expected]) => value[key] === expected),
    'The submission manifest no longer matches the pinned workflow identity.', 'repository_guard');
  }

  await repository();
  let pr = await pull();
  if (pr.state !== 'open' || pr.draft) return { status: pr.merged ? 'merged' : 'closed', pullRequest: prNumber };
  if (expectedHead && pr.head.sha !== expectedHead) return { status: 'stale', pullRequest: prNumber };
  const headSHA = pr.head.sha;
  const baseSHA = await ref('main');
  requireValue(pr.base.sha === baseSHA, 'The base branch changed. Retry against its current version.', 'submission_conflict');
  const comparison = await api(`${root}/compare/${baseSHA}...${headSHA}`);
  requireValue(comparison.merge_base_commit?.sha === baseSHA && comparison.status === 'ahead',
    'This submission is based on an older version. Reload the form and submit the current revision.', 'submission_conflict');

  requireValue(Number.isSafeInteger(pr.changed_files) && pr.changed_files >= 1 && pr.changed_files <= ALLOWED_PATHS.length,
    'Only the two PDFs and submission Markdown may change.', 'repository_guard');
  const changed = await api(`${root}/pulls/${prNumber}/files?per_page=100`);
  requireValue(Array.isArray(changed) && changed.length === pr.changed_files &&
    new Set(changed.map((item) => item.filename)).size === changed.length &&
    changed.every((item) => ALLOWED_PATHS.includes(item.filename) && ['added', 'modified'].includes(item.status) && !item.previous_filename),
  'The pull request includes an unapproved path, deletion, or rename.', 'repository_guard');

  const [baseTree, headTree] = await Promise.all([tree(baseSHA), tree(headSHA)]);
  const actualChanged = [];
  for (const path of new Set([...baseTree.keys(), ...headTree.keys()])) {
    const before = baseTree.get(path), after = headTree.get(path);
    if (before?.sha === after?.sha && before?.mode === after?.mode && before?.type === after?.type) continue;
    requireValue(ALLOWED_PATHS.includes(path) && after?.type === 'blob' && after.mode === '100644' &&
      (!before || (before.type === 'blob' && before.mode === '100644')),
    'The complete commit changes infrastructure or an unsupported file type.', 'repository_guard');
    actualChanged.push(path);
  }
  requireValue(actualChanged.length === changed.length && changed.every((item) => actualChanged.includes(item.filename)),
    'The pull-request file list does not match its commit tree.', 'repository_guard');
  await manifest(baseTree);
  await manifest(headTree);

  const markdown = (await file(headTree, 'submission.md', MAX_MARKDOWN_BYTES)).toString('utf8');
  const record = parseSubmissionMarkdown(markdown);
  requireValue(record.id === id && record.editKeyHash === hash('sha256', id),
    'Submission metadata does not match this assigned repository.', 'repository_guard');
  if (baseTree.has('submission.md')) {
    const previous = parseSubmissionMarkdown((await file(baseTree, 'submission.md', MAX_MARKDOWN_BYTES)).toString('utf8'));
    requireValue(previous.id === id && previous.createdAt === record.createdAt,
      'An update cannot replace the existing submission identity.', 'repository_guard');
  }
  for (const [kind, path] of [['cv', 'cv.pdf'], ['sample', 'sample.pdf']]) {
    const bytes = await file(headTree, path, maximum);
    const checked = await validatePdf(new Uint8Array(bytes), record.files[kind].name,
      { maxBytes: maximum, maxPages: 100, label: kind === 'cv' ? 'CV' : 'Sample' });
    requireValue(checked.info.bytes === record.files[kind].bytes && checked.info.pages === record.files[kind].pages &&
      checked.info.name === record.files[kind].name,
    'The PDF details do not match the submitted metadata.', 'validation_failed');
  }

  if (env.AUTO_MERGE === 'false') return { status: 'validated', pullRequest: prNumber, headSHA };
  // Every attempt is bound to the same inspected head AND base. No force push,
  // workflow execution, self-approval, or administrator bypass occurs here.
  for (let attempt = 0; attempt < 3; attempt++) {
    await repository();
    pr = await pull();
    if (pr.state === 'closed') return { status: pr.merged ? 'merged' : 'closed', pullRequest: prNumber, headSHA };
    if (pr.head.sha !== headSHA || await ref('submission') !== headSHA) return { status: 'stale', pullRequest: prNumber, headSHA };
    requireValue(pr.base.sha === baseSHA && await ref('main') === baseSHA,
      'The saved version changed during validation. Reload and submit the current revision.', 'submission_conflict');
    if (pr.draft || pr.mergeable === false || ['blocked', 'dirty'].includes(pr.mergeable_state)) {
      return { status: 'pending', pullRequest: prNumber, headSHA };
    }
    if (pr.mergeable === null && attempt < 2) { await sleep(1000 * (attempt + 1)); continue; }
    try {
      const result = await api(`${root}/pulls/${prNumber}/merge`, {
        method: 'PUT', body: { sha: headSHA, merge_method: 'squash', commit_title: 'Save submission' },
      });
      return { status: result.merged === true ? 'merged' : 'pending', pullRequest: prNumber, headSHA, mergeSHA: result.sha || null };
    } catch (error) {
      if (![405, 409, 422].includes(error.status)) throw error;
      if (error.status === 405 && attempt < 2) { await sleep(1000 * (attempt + 1)); continue; }
      return { status: 'pending', pullRequest: prNumber, headSHA };
    }
  }
  return { status: 'pending', pullRequest: prNumber, headSHA };
}

async function main() {
  try {
    const result = await validateAndMerge(process.env);
    const messages = {
      merged: 'The two PDFs and submission record were validated and saved.',
      validated: 'The submission passed validation. Automatic merging is disabled.',
      pending: 'The submission was validated. GitHub merge requirements still need administrator attention.',
      stale: 'A newer revision replaced this workflow run. Its own validation run will handle it.',
      closed: 'This pull request is closed; no files were changed.',
    };
    const message = messages[result.status] || 'Validation completed.';
    console.log(message);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Submission result\n\n${message}\n`);
  } catch (error) {
    // Never print API responses, credentials, applicant fields, or PDF bytes.
    const message = error instanceof SubmissionGateError || error.name === 'ValidationError'
      ? error.message : 'The submission could not be validated. An administrator should inspect this workflow.';
    console.error(message);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Submission was not merged\n\n${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
