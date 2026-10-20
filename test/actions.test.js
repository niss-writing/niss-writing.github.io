import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFName } from 'pdf-lib';
import { renderSubmissionMarkdown } from '../src/validation.js';
import { validateAndMerge } from '../scripts/validate-and-merge.mjs';
import { provision, renderPrivateWorkflow } from '../scripts/provision.mjs';

const ID = '2d407a12-9532-48ea-8aa4-529343757c30';
const REQUEST = 'a064f894-9428-4cf5-8d50-ae8590173e40';
const OWNER = 'example-owner';
const NAME = `temporary-entry-${ID}`;
const REPO = `${OWNER}/${NAME}`;
const REPO_ID = 1234567;
const SOURCE = `${OWNER}/${OWNER}.github.io`;
const SHA = (value) => createHash('sha1').update(value).digest('hex');
const BLOB_SHA = (bytes) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const BASE = SHA('base');
const HEAD = SHA('head');
const MERGE = SHA('merge');
const SOURCE_SHA = SHA('source');
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
const manifest = () => ({ schemaVersion: 2, id: ID, repositoryId: REPO_ID, owner: OWNER, name: NAME, defaultBranch: 'main' });
const ENV = {
  GITHUB_TOKEN: 'test-only-actions-token', GITHUB_REPOSITORY: REPO,
  GITHUB_EVENT_NAME: 'pull_request_target', PR_NUMBER: '1', REQUEST_HEAD_SHA: HEAD,
  EXPECTED_SUBMISSION_ID: ID, EXPECTED_REPOSITORY_ID: String(REPO_ID),
  EXPECTED_OWNER: OWNER, EXPECTED_REPOSITORY_NAME: NAME, EXPECTED_BRANCH: 'submission',
};

async function fixture({ activePDF = false } = {}) {
  const document = await PDFDocument.create();
  document.addPage([200, 200]);
  if (activePDF) document.catalog.set(PDFName.of('OpenAction'), document.context.obj({ S: 'JavaScript', JS: 'app.alert(1)' }));
  const pdf = await document.save({ useObjectStreams: false });
  const record = {
    id: ID, requestId: REQUEST,
    data: {
      fullName: 'Ada Example', email: 'ada@example.org', affiliation: 'Example University',
      careerStage: 'Doctoral student', field: 'Statistics', sampleTitle: 'A short paper',
      summary: 'Summary text.', goals: 'Improve exposition.', notes: '', consent: true,
    },
    files: { cv: { name: 'cv-original.pdf', bytes: pdf.length, pages: 1 }, sample: { name: 'sample-original.pdf', bytes: pdf.length, pages: 1 } },
    createdAt: '2026-10-19T00:00:00.000Z', submittedAt: '2026-10-19T01:00:00.000Z',
    editKeyHash: createHash('sha256').update(ID).digest('hex'),
  };
  const blobs = new Map();
  const makeEntry = (path, bytes) => {
    const value = Buffer.from(bytes);
    const sha = BLOB_SHA(value);
    blobs.set(sha, value);
    return { path, type: 'blob', mode: '100644', sha, size: value.length };
  };
  const base = [
    makeEntry('README.md', 'Private storage'),
    makeEntry('.submission-config.json', JSON.stringify(manifest())),
    makeEntry('.github/workflows/validate-submission.yml', 'Pinned trusted workflow'),
  ];
  const head = [...base,
    makeEntry('submission.md', renderSubmissionMarkdown(record)),
    makeEntry('cv.pdf', pdf), makeEntry('sample.pdf', pdf),
  ];
  const state = {
    calls: [], private: true, repoReads: 0, headSHA: HEAD, baseSHA: BASE,
    mergeable: true, mergeableState: 'clean', mergeFailures: [], merged: false,
    comparisonBase: BASE, afterRepositoryRead: null, base, head, makeEntry,
  };
  const repo = () => ({ id: REPO_ID, name: NAME, owner: { login: OWNER }, full_name: REPO, private: state.private, default_branch: 'main' });
  const pr = () => ({
    number: 1, state: state.merged ? 'closed' : 'open', draft: false, merged: state.merged,
    base: { ref: 'main', sha: state.baseSHA, repo: repo() },
    head: { ref: 'submission', sha: state.headSHA, repo: repo() },
    changed_files: 3, mergeable: state.mergeable, mergeable_state: state.mergeableState,
  });
  const fetchImpl = async (urlString, options = {}) => {
    const url = new URL(urlString);
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(options.redirect, 'error');
    const method = options.method || 'GET';
    const path = url.pathname.slice(`/repos/${REPO}`.length);
    const body = options.body ? JSON.parse(options.body) : null;
    state.calls.push({ method, path, body });
    if (path === '') {
      state.repoReads++;
      state.afterRepositoryRead?.(state);
      return response(repo());
    }
    if (path === '/pulls/1' && method === 'GET') return response(pr());
    if (path === '/git/ref/heads/main') return response({ ref: 'refs/heads/main', object: { type: 'commit', sha: state.baseSHA } });
    if (path === '/git/ref/heads/submission') return response({ ref: 'refs/heads/submission', object: { type: 'commit', sha: state.headSHA } });
    if (path.startsWith('/compare/')) return response({ status: 'ahead', merge_base_commit: { sha: state.comparisonBase } });
    if (path === '/pulls/1/files') return response(['submission.md', 'cv.pdf', 'sample.pdf'].map((filename) => ({ filename, status: 'added' })));
    if (path === `/git/commits/${BASE}`) return response({ sha: BASE, tree: { sha: SHA('base-tree') } });
    if (path === `/git/commits/${HEAD}`) return response({ sha: HEAD, tree: { sha: SHA('head-tree') } });
    if (path === `/git/trees/${SHA('base-tree')}`) return response({ sha: SHA('base-tree'), truncated: false, tree: state.base });
    if (path === `/git/trees/${SHA('head-tree')}`) return response({ sha: SHA('head-tree'), truncated: false, tree: state.head });
    if (path.startsWith('/git/blobs/')) {
      const sha = path.split('/').at(-1);
      const bytes = blobs.get(sha);
      return response({ sha, encoding: 'base64', content: bytes.toString('base64') });
    }
    if (path === '/pulls/1/merge' && method === 'PUT') {
      assert.deepEqual(body, { sha: HEAD, merge_method: 'squash', commit_title: 'Save submission' });
      if (state.mergeFailures.length) return response({}, state.mergeFailures.shift());
      state.merged = true;
      return response({ merged: true, sha: MERGE });
    }
    throw new Error(`Unexpected fake GitHub request: ${method} ${path}`);
  };
  return { state, run: (env = {}) => validateAndMerge({ ...ENV, ...env }, { fetchImpl, sleep: async () => {} }) };
}

test('Actions validates bounded private data and binds the squash merge to the inspected head', async () => {
  const { state, run } = await fixture();
  const result = await run();
  assert.equal(result.status, 'merged');
  assert.equal(result.mergeSHA, MERGE);
  assert.equal(state.calls.filter((call) => call.method !== 'GET').length, 1);
  assert.equal(state.calls.find((call) => call.method === 'PUT').path, '/pulls/1/merge');
});

test('Actions full-tree inspection rejects infrastructure hidden from the PR files list', async () => {
  const { state, run } = await fixture();
  state.head.push(state.makeEntry('scripts/execute-me.js', 'throw new Error("must never execute")'));
  await assert.rejects(run(), (error) => error.code === 'repository_guard');
  assert.equal(state.calls.filter((call) => call.method !== 'GET').length, 0);
});

test('Actions rejects symlinks, a public target, and tampered identity metadata', async () => {
  const symlink = await fixture();
  symlink.state.head.find((entry) => entry.path === 'cv.pdf').mode = '120000';
  await assert.rejects(symlink.run(), (error) => error.code === 'repository_guard');
  const publicTarget = await fixture();
  publicTarget.state.private = false;
  await assert.rejects(publicTarget.run(), (error) => error.code === 'repository_guard');
  const wrongManifest = await fixture();
  const invalid = wrongManifest.state.makeEntry('.submission-config.json', JSON.stringify({ ...manifest(), repositoryId: 77 }));
  wrongManifest.state.base = wrongManifest.state.base.map((entry) => entry.path === invalid.path ? invalid : entry);
  wrongManifest.state.head = wrongManifest.state.head.map((entry) => entry.path === invalid.path ? invalid : entry);
  await assert.rejects(wrongManifest.run(), (error) => error.code === 'repository_guard');
});

test('Actions rejects an active PDF before any merge operation', async () => {
  const { state, run } = await fixture({ activePDF: true });
  await assert.rejects(run());
  assert.equal(state.calls.filter((call) => call.method !== 'GET').length, 0);
});

test('Actions skips stale event heads and head changes after file inspection', async () => {
  const oldEvent = await fixture();
  assert.equal((await oldEvent.run({ REQUEST_HEAD_SHA: SHA('older-head') })).status, 'stale');
  assert.equal(oldEvent.state.calls.filter((call) => call.method !== 'GET').length, 0);
  const race = await fixture();
  race.state.afterRepositoryRead = (state) => { if (state.repoReads === 2) state.headSHA = SHA('newer-head'); };
  assert.equal((await race.run()).status, 'stale');
  assert.equal(race.state.calls.filter((call) => call.method !== 'GET').length, 0);
});

test('Actions rejects a stale base and leaves merge requirements pending', async () => {
  const stale = await fixture();
  stale.state.comparisonBase = SHA('old-base');
  await assert.rejects(stale.run(), (error) => error.code === 'submission_conflict');
  const blocked = await fixture();
  blocked.state.mergeableState = 'blocked';
  assert.equal((await blocked.run()).status, 'pending');
  assert.equal(blocked.state.calls.filter((call) => call.method !== 'GET').length, 0);
});

test('Actions retries transient merge readiness without changing the inspected SHA', async () => {
  const { state, run } = await fixture();
  state.mergeFailures = [405, 405];
  assert.equal((await run()).status, 'merged');
  const attempts = state.calls.filter((call) => call.method === 'PUT');
  assert.equal(attempts.length, 3);
  assert.ok(attempts.every((attempt) => attempt.body.sha === HEAD));
});

test('private workflow executes only a pinned public checkout and locked trusted dependencies', async () => {
  const template = await readFile(new URL('../templates/private-submission/.github/workflows/validate-submission.yml', import.meta.url), 'utf8');
  const rendered = renderPrivateWorkflow(template, {
    SOURCE_REPOSITORY: SOURCE, SOURCE_SHA, SUBMISSION_ID: ID,
    REPOSITORY_ID: REPO_ID, OWNER, REPOSITORY_NAME: NAME,
  });
  assert.ok(rendered.includes(`repository: '${SOURCE}'`));
  assert.ok(rendered.includes(`ref: '${SOURCE_SHA}'`));
  assert.ok(rendered.includes('persist-credentials: false'));
  assert.ok(rendered.includes('working-directory: trusted'));
  assert.ok(rendered.includes('npm ci --omit=dev --ignore-scripts'));
  assert.ok(!rendered.includes('ref: ${{ github.event.pull_request.head.sha }}'));
  assert.ok(!rendered.includes('npm ci\n'));
  assert.ok(!/__SOURCE_SHA__|__OWNER__/.test(rendered));
});

test('organizer provisioning seeds a private pinned workflow and reports unavailable branch protection', async () => {
  const calls = [];
  let created = false;
  const run = async (args, options) => {
    const path = args[3];
    const method = args[5];
    const body = options.input ? JSON.parse(options.input) : null;
    calls.push({ path, method, body });
    const dataRepo = { id: REPO_ID, private: true, full_name: REPO, default_branch: 'main' };
    let result;
    if (path === `/repos/${SOURCE}`) result = { private: false, full_name: SOURCE, default_branch: 'main' };
    else if (path === `/repos/${SOURCE}/commits/main`) result = { sha: SOURCE_SHA, commit: { tree: { sha: SHA('source-tree') } } };
    else if (path === `/repos/${SOURCE}/git/trees/${SHA('source-tree')}?recursive=1`) {
      result = { truncated: false, tree: ['scripts/validate-and-merge.mjs', 'src/validation.js', 'package.json', 'package-lock.json'].map((path) => ({ path, type: 'blob', mode: '100644' })) };
    } else if (path === `/users/${OWNER}`) result = { login: OWNER, type: 'Organization' };
    else if (path === `/orgs/${OWNER}/repos` && method === 'POST') { created = true; assert.equal(body.private, true); result = dataRepo; }
    else if (path === `/repos/${REPO}`) { assert.ok(created); result = dataRepo; }
    else if (path.endsWith('/git/ref/heads/main')) result = { object: { sha: BASE } };
    else if (path.endsWith(`/git/commits/${BASE}`)) result = { tree: { sha: SHA('base-tree') } };
    else if (path.endsWith('/git/blobs')) result = { sha: SHA(body.content) };
    else if (path.endsWith('/git/trees')) result = { sha: SHA('new-tree') };
    else if (path.endsWith('/git/commits')) result = { sha: HEAD };
    else if (path.endsWith('/git/refs/heads/main')) { assert.equal(body.force, false); result = {}; }
    else if (path.endsWith('/actions/permissions/workflow')) { assert.equal(body.default_workflow_permissions, 'read'); result = {}; }
    else if (path.endsWith('/branches/main/protection')) throw Object.assign(new Error('Unavailable on this plan'), { status: 403 });
    else throw new Error(`Unexpected setup request: ${method} ${path}`);
    return JSON.stringify(result);
  };
  const result = await provision({ owner: OWNER, source: SOURCE }, { run, uuid: () => ID, sleep: async () => {} });
  assert.equal(result.fullName, REPO);
  assert.equal(result.protection, 'not-enabled');
  assert.ok(result.warnings.some((message) => message.includes('scoped credential')));
  assert.equal(result.accessCommand, `node scripts/access-code.mjs ${REPO}`);
  const uploaded = calls.filter((call) => call.path.endsWith('/git/blobs')).map((call) => call.body.content);
  assert.equal(uploaded.length, 3);
  assert.ok(uploaded.some((content) => content.includes(SOURCE_SHA) && content.includes('actions/checkout@')));
  assert.ok(uploaded.some((content) => content.includes('"schemaVersion": 2') && content.includes(`"repositoryId": ${REPO_ID}`)));
  assert.ok(!uploaded.some((content) => content.includes('github_pat_')));
});
