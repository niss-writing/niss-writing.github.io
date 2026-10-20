import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { createPagesStore } from '../src/pages-github.js';
import { renderSubmissionMarkdown, validatePdf } from '../src/validation.js';

const ID = '2d407a12-9532-48ea-8aa4-529343757c30';
const REQUEST = 'a064f894-9428-4cf5-8d50-ae8590173e40';
const NEXT_REQUEST = 'b064f894-9428-4cf5-8d50-ae8590173e40';
const THIRD_REQUEST = 'c064f894-9428-4cf5-8d50-ae8590173e40';
const OWNER = 'example-owner';
const NAME = `temporary-entry-${ID}`;
const ENV = {
  GITHUB_OWNER: OWNER,
  GITHUB_OWNER_TYPE: 'user',
  GITHUB_TOKEN: 'fake-test-credential',
  SUBMISSION_SECRET: '12'.repeat(32),
};
const sha = (value) => createHash('sha1').update(value).digest('hex');
const blobSHA = (bytes) => sha(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), Buffer.from(bytes)]));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A small, entirely offline GitHub contract fake, including non-FF rejection. */
class FakeGitHub {
  constructor() {
    this.repo = null;
    this.refs = new Map();
    this.blobs = new Map();
    this.trees = new Map();
    this.commits = new Map();
    this.prs = [];
    this.calls = [];
    this.clock = 0;
    this.userLogin = OWNER;
    this.blocked = false;
    this.mergeFailures = [];
    this.failPRCreateOnce = false;
    this.beforePatch = null;
    this.extraTreePath = null;
    this.fileChangesOverride = null;
    this.fetch = this.fetch.bind(this);
  }

  addBlob(bytes) {
    const value = Buffer.from(bytes);
    const hash = blobSHA(value);
    this.blobs.set(hash, value);
    return hash;
  }

  addTree(entries) {
    const tree = [...entries].map(([path, entry]) => ({ ...entry, path }))
      .sort((a, b) => a.path.localeCompare(b.path));
    const hash = sha(`tree:${JSON.stringify(tree)}`);
    this.trees.set(hash, tree);
    return hash;
  }

  addCommit(tree, parents = []) {
    const hash = sha(`commit:${tree}:${parents.join(',')}:${this.clock++}`);
    this.commits.set(hash, { sha: hash, tree: { sha: tree }, parents: parents.map((parent) => ({ sha: parent })) });
    return hash;
  }

  initialize(description = 'Unrelated repository', options = {}) {
    this.repo = {
      id: 1234567, name: NAME, full_name: `${OWNER}/${NAME}`,
      owner: { login: OWNER }, private: true, archived: false, disabled: false,
      fork: false, default_branch: 'main', description, ...options,
    };
    const bytes = Buffer.from('# Temporary storage\n');
    const blob = this.addBlob(bytes);
    const tree = this.addTree(new Map([['README.md', { type: 'blob', mode: '100644', sha: blob, size: bytes.length }]]));
    this.refs.set(this.repo.default_branch, this.addCommit(tree));
  }

  entriesAt(commit) {
    const tree = this.trees.get(this.commits.get(commit).tree.sha);
    return new Map(tree.map((entry) => [entry.path, entry]));
  }

  isAncestor(ancestor, descendant, seen = new Set()) {
    if (ancestor === descendant) return true;
    if (seen.has(descendant)) return false;
    seen.add(descendant);
    return this.commits.get(descendant)?.parents.some((parent) => this.isAncestor(ancestor, parent.sha, seen)) || false;
  }

  changes(pr) {
    if (this.fileChangesOverride) return this.fileChangesOverride;
    const base = this.entriesAt(this.refs.get(this.repo.default_branch));
    const head = this.entriesAt(pr.state === 'open' ? this.refs.get('submission') : pr.headSHA);
    const changes = [];
    for (const path of new Set([...base.keys(), ...head.keys()])) {
      const before = base.get(path), after = head.get(path);
      if (before?.sha === after?.sha && before?.mode === after?.mode) continue;
      changes.push({ filename: path, status: !before ? 'added' : !after ? 'removed' : 'modified', sha: after?.sha });
    }
    return changes;
  }

  formatPR(pr) {
    const repo = { id: this.repo.id, full_name: this.repo.full_name, private: this.repo.private };
    return {
      number: pr.number, state: pr.state,
      merged: !!pr.merged_at, merged_at: pr.merged_at || null, draft: false,
      merge_commit_sha: pr.mergeSHA || null,
      head: { ref: 'submission', sha: pr.state === 'open' ? this.refs.get('submission') : pr.headSHA, repo },
      base: { ref: this.repo.default_branch, sha: this.refs.get(this.repo.default_branch), repo },
      changed_files: this.changes(pr).length,
      mergeable: !this.blocked,
      mergeable_state: this.blocked ? 'blocked' : 'clean',
    };
  }

  async fetch(input, options = {}) {
    const url = new URL(input);
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(options.redirect, 'error');
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    const path = decodeURIComponent(url.pathname);
    this.calls.push({ method, path, body });
    if (method === 'GET' && path === '/user') return json({ login: this.userLogin });
    if (method === 'POST' && (path === '/user/repos' || path === `/orgs/${OWNER}/repos`)) {
      if (this.repo) return json({ message: 'Already exists' }, 422);
      assert.equal(body.private, true);
      assert.equal(body.auto_init, true);
      this.initialize(body.description, { name: body.name });
      return json(this.repo, 201);
    }
    const root = `/repos/${OWNER}/${NAME}`;
    if (path === root && method === 'GET') return this.repo ? json(this.repo) : json({}, 404);
    assert.ok(path.startsWith(`${root}/`), `Unexpected endpoint ${method} ${path}`);
    if (!this.repo) return json({}, 404);
    const tail = path.slice(root.length);
    if (method === 'GET' && tail.startsWith('/git/ref/heads/')) {
      const branch = tail.slice('/git/ref/heads/'.length);
      const value = this.refs.get(branch);
      return value ? json({ ref: `refs/heads/${branch}`, object: { type: 'commit', sha: value } }) : json({}, 404);
    }
    if (method === 'GET' && tail.startsWith('/git/commits/')) return json(this.commits.get(tail.split('/').at(-1)));
    if (method === 'GET' && tail.startsWith('/git/trees/')) {
      const hash = tail.split('/').at(-1);
      return json({ sha: hash, truncated: false, tree: this.trees.get(hash) });
    }
    if (method === 'GET' && tail.startsWith('/git/blobs/')) {
      const hash = tail.split('/').at(-1);
      const bytes = this.blobs.get(hash);
      return json({ sha: hash, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') });
    }
    if (method === 'POST' && tail === '/git/blobs') {
      assert.equal(body.encoding, 'base64');
      return json({ sha: this.addBlob(Buffer.from(body.content, 'base64')) }, 201);
    }
    if (method === 'POST' && tail === '/git/trees') {
      const entries = new Map(this.trees.get(body.base_tree).map((entry) => [entry.path, { ...entry }]));
      for (const entry of body.tree) entries.set(entry.path, { ...entry, size: this.blobs.get(entry.sha).length });
      if (this.extraTreePath) {
        const bytes = Buffer.from('unexpected code');
        entries.set(this.extraTreePath, { path: this.extraTreePath, type: 'blob', mode: '100644', sha: this.addBlob(bytes), size: bytes.length });
      }
      return json({ sha: this.addTree(entries) }, 201);
    }
    if (method === 'POST' && tail === '/git/commits') return json({ sha: this.addCommit(body.tree, body.parents) }, 201);
    if (method === 'POST' && tail === '/git/refs') {
      const branch = body.ref.slice('refs/heads/'.length);
      if (this.refs.has(branch)) return json({}, 422);
      this.refs.set(branch, body.sha);
      return json({ ref: body.ref, object: { type: 'commit', sha: body.sha } }, 201);
    }
    if (method === 'PATCH' && tail === '/git/refs/heads/submission') {
      if (this.beforePatch) {
        const hook = this.beforePatch;
        this.beforePatch = null;
        await hook(this);
      }
      assert.equal(body.force, false, 'Branch updates must never force.');
      if (!this.isAncestor(this.refs.get('submission'), body.sha)) return json({ message: 'Not a fast forward' }, 422);
      this.refs.set('submission', body.sha);
      return json({ ref: 'refs/heads/submission', object: { type: 'commit', sha: body.sha } });
    }
    if (method === 'GET' && tail === '/pulls') return json([...this.prs].reverse().map((pr) => this.formatPR(pr)));
    if (method === 'POST' && tail === '/pulls') {
      if (this.failPRCreateOnce) { this.failPRCreateOnce = false; return json({}, 503); }
      if (this.prs.some((pr) => pr.state === 'open')) return json({}, 422);
      assert.equal(body.head, 'submission');
      assert.equal(body.base, this.repo.default_branch);
      const pr = { number: this.prs.length + 1, state: 'open', headSHA: this.refs.get('submission') };
      this.prs.push(pr);
      return json(this.formatPR(pr), 201);
    }
    const match = tail.match(/^\/pulls\/(\d+)(\/files|\/merge)?$/);
    if (match) {
      const pr = this.prs[Number(match[1]) - 1];
      if (method === 'GET' && !match[2]) return json(this.formatPR(pr));
      if (method === 'GET' && match[2] === '/files') return json(this.changes(pr));
      if (method === 'PUT' && match[2] === '/merge') {
        assert.equal(body.merge_method, 'squash');
        assert.equal(body.sha, this.refs.get('submission'));
        if (this.mergeFailures.length) return json({}, this.mergeFailures.shift());
        if (this.blocked) return json({}, 405);
        const head = this.commits.get(body.sha);
        const mergedSHA = this.addCommit(head.tree.sha, [this.refs.get(this.repo.default_branch)]);
        this.refs.set(this.repo.default_branch, mergedSHA);
        pr.headSHA = body.sha;
        pr.state = 'closed';
        pr.merged_at = '2026-10-19T12:00:00.000Z';
        pr.mergeSHA = mergedSHA;
        return json({ merged: true, sha: mergedSHA });
      }
    }
    throw new Error(`Unexpected fake request: ${method} ${tail}`);
  }

  mutations() { return this.calls.filter((call) => call.method !== 'GET'); }
  mergeCalls() { return this.calls.filter((call) => call.path.endsWith('/merge')); }
}


function setupPages(overrides = {}) {
  const fake = new FakeGitHub();
  fake.initialize('Temporary submission storage');
  const manifest = { schemaVersion: 2, id: ID, repositoryId: fake.repo.id, owner: OWNER, name: NAME, defaultBranch: 'main', ...overrides };
  const entries = fake.entriesAt(fake.refs.get('main'));
  const bytes = Buffer.from(JSON.stringify(manifest));
  entries.set('.submission-config.json', { type: 'blob', mode: '100644', sha: fake.addBlob(bytes), size: bytes.length });
  const workflow = Buffer.from('# trusted validation workflow placeholder\n');
  entries.set('.github/workflows/validate-submission.yml', { type: 'blob', mode: '100644', sha: fake.addBlob(workflow), size: workflow.length });
  fake.refs.set('main', fake.addCommit(fake.addTree(entries)));
  const options = { owner: OWNER, repo: NAME, id: ID, token: 'github_pat_' + 'a'.repeat(40), fetchImpl: fake.fetch };
  return { fake, options, store: createPagesStore(options) };
}
let fixtureBytes;
async function pagesRecord(requestId = REQUEST, changes = {}) {
  if (!fixtureBytes) {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    fixtureBytes = await doc.save();
  }
  const cv = await validatePdf(fixtureBytes, 'my-cv.pdf');
  const sample = await validatePdf(fixtureBytes, 'my-sample.pdf');
  return {
    id: ID, data: {
      fullName: 'Ada Example', email: 'ada@example.org', affiliation: 'Example University',
      careerStage: 'Doctoral student', field: 'Statistics', sampleTitle: 'A short paper',
      summary: 'Summary text.', goals: 'Improve exposition.', notes: '', consent: true, ...changes,
    },
    files: { cv: cv.info, sample: sample.info }, pdfBytes: { cv: cv.bytes, sample: sample.bytes },
    editKeyHash: createHash('sha256').update(ID).digest('hex'),
    createdAt: '2026-10-19T00:00:00.000Z', submittedAt: '2026-10-19T01:00:00.000Z', requestId,
  };
}
function actionMerges(fake) {
  const pr = fake.prs.find((value) => value.state === 'open');
  const headSHA = fake.refs.get('submission');
  const head = fake.commits.get(headSHA);
  const mergedSHA = fake.addCommit(head.tree.sha, [fake.refs.get('main')]);
  fake.refs.set('main', mergedSHA);
  pr.headSHA = headSHA; pr.state = 'closed'; pr.merged_at = '2026-10-19T12:00:00.000Z'; pr.merge_commit_sha = mergedSHA;
  return mergedSHA;
}

const hasCode = (code) => (error) => error.code === code;

test('Pages loads a provisioned empty private repository without creating anything', async () => {
  const { fake, store } = setupPages();
  assert.equal(await store.load(), null);
  assert.equal(fake.mutations().length, 0);
});

test('Pages submits exactly three data files through a pending PR and never merges or provisions', async () => {
  const { fake, store, options } = setupPages();
  const originalMain = fake.refs.get('main');
  const originalTree = fake.entriesAt(originalMain);
  const input = await pagesRecord();
  const result = await store.save(input, { requestId: REQUEST });
  assert.equal(result.receipt.status, 'pending');
  assert.equal(result.record.receipt.status, 'pending');
  assert.equal(fake.refs.get('main'), originalMain);
  assert.equal(fake.prs.length, 1);
  assert.equal(fake.mergeCalls().length, 0);
  assert.ok(fake.mutations().every((call) => call.path.startsWith(`/repos/${OWNER}/${NAME}/`)));
  const tree = fake.entriesAt(fake.refs.get('submission'));
  assert.deepEqual([...tree.keys()].sort(), ['.github/workflows/validate-submission.yml', '.submission-config.json', 'README.md', 'cv.pdf', 'sample.pdf', 'submission.md']);
  for (const [path, entry] of originalTree) assert.equal(tree.get(path).sha, entry.sha);
  assert.equal(result.record.markdown.includes(options.token), false);
  assert.equal(JSON.stringify(fake.calls).includes(options.token), false);
  const loaded = await createPagesStore(options).load();
  assert.equal(loaded.version, result.record.version);
  assert.equal(loaded.receipt.status, 'pending');
  assert.deepEqual(loaded.pdfBytes, input.pdfBytes);
  assert.deepEqual(loaded.data, input.data);
});

test('Pages edits a pending PR using the persistent branch without forcing or duplicating the PR', async () => {
  const { fake, store } = setupPages();
  const first = await store.save(await pagesRecord(), { requestId: REQUEST });
  const next = await store.save(await pagesRecord(NEXT_REQUEST, { goals: 'Updated goals.' }), { requestId: NEXT_REQUEST, expectedVersion: first.record.version });
  assert.equal(fake.prs.length, 1);
  assert.equal(next.record.data.goals, 'Updated goals.');
  assert.notEqual(next.record.version, first.record.version);
  assert.ok(fake.calls.filter((call) => call.method === 'PATCH').every((call) => call.body.force === false));
  await assert.rejects(store.save(await pagesRecord(THIRD_REQUEST), { requestId: THIRD_REQUEST, expectedVersion: first.record.version }), hasCode('submission_conflict'));
});

test('Pages detects the Action merge and creates a new PR for a later revision', async () => {
  const { fake, store, options } = setupPages();
  await store.save(await pagesRecord(), { requestId: REQUEST });
  const main = actionMerges(fake);
  const loaded = await createPagesStore(options).load();
  assert.equal(loaded.receipt.status, 'merged');
  assert.equal(loaded.version, main);
  const second = await createPagesStore(options).save(await pagesRecord(NEXT_REQUEST, { affiliation: 'Updated affiliation' }), { requestId: NEXT_REQUEST, expectedVersion: main });
  assert.equal(second.receipt.status, 'pending');
  assert.equal(fake.prs.length, 2);
  assert.equal(fake.mergeCalls().length, 0);
});

test('Pages retries are idempotent and changed answers or filenames cannot reuse a request ID', async () => {
  const { fake, store } = setupPages();
  const input = await pagesRecord();
  const first = await store.save(input, { requestId: REQUEST });
  const count = fake.mutations().length;
  const retry = await store.save(input, { requestId: REQUEST });
  assert.equal(retry.record.version, first.record.version);
  assert.equal(fake.mutations().length, count);
  await assert.rejects(store.save(await pagesRecord(REQUEST, { goals: 'Different intent' }), { requestId: REQUEST }), hasCode('submission_conflict'));
  const renamed = await pagesRecord();
  renamed.files.cv.name = 'renamed.pdf';
  await assert.rejects(store.save(renamed, { requestId: REQUEST }), hasCode('submission_conflict'));
  assert.equal(fake.mutations().length, count);
});

test('Pages recovers a saved branch after PR creation fails without adding duplicate commits', async () => {
  const { fake, store } = setupPages();
  fake.failPRCreateOnce = true;
  const input = await pagesRecord();
  await assert.rejects(store.save(input, { requestId: REQUEST }), hasCode('github_error'));
  const branch = fake.refs.get('submission');
  const retry = await store.save(input, { requestId: REQUEST });
  assert.equal(retry.record.version, branch);
  assert.equal(fake.prs.length, 1);
  assert.equal(fake.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/git/commits')).length, 1);
});

test('Pages never force-overwrites a concurrent save', async () => {
  const { fake, store } = setupPages();
  const first = await store.save(await pagesRecord(), { requestId: REQUEST });
  fake.beforePatch = async (backend) => {
    const previous = backend.refs.get('submission');
    backend.refs.set('submission', backend.addCommit(backend.commits.get(previous).tree.sha, [previous]));
  };
  await assert.rejects(store.save(await pagesRecord(NEXT_REQUEST), { requestId: NEXT_REQUEST, expectedVersion: first.record.version }), hasCode('submission_conflict'));
  assert.ok(fake.calls.filter((call) => call.method === 'PATCH').every((call) => call.body.force === false));
});

test('Pages guards private visibility, manifest identity, repository recreation, and missing repositories', async () => {
  for (const overrides of [{ id: NEXT_REQUEST }, { repositoryId: 99 }, { owner: 'different-owner' }, { schemaVersion: 1 }]) {
    const { fake, store } = setupPages(overrides);
    await assert.rejects(store.load(), hasCode('repository_guard'));
    assert.equal(fake.mutations().length, 0);
  }
  const { fake, store } = setupPages();
  fake.repo.private = false;
  await assert.rejects(store.load(), hasCode('repository_guard'));
  fake.repo.private = true;
  await store.load();
  fake.repo.id += 1;
  await assert.rejects(store.load(), hasCode('repository_guard'));
  const missing = setupPages(); missing.fake.repo = null;
  await assert.rejects(missing.store.load(), hasCode('repository_missing'));
});

test('Pages uses only the fixed GitHub API origin, hides upstream details, and clears its token on disconnect', async () => {
  const { options, fake } = setupPages();
  let lastAuthorization;
  const store = createPagesStore({ ...options, fetchImpl: async (url, request) => {
    assert.equal(new URL(url).origin, 'https://api.github.com');
    assert.equal(request.redirect, 'error');
    lastAuthorization = request.headers.Authorization;
    return fake.fetch(url, request);
  } });
  await store.load();
  assert.equal(lastAuthorization, `Bearer ${options.token}`);
  store.disconnect();
  await assert.rejects(store.load(), hasCode('authentication'));
  const rejected = createPagesStore({ ...options, fetchImpl: async () => json({ message: 'SECRET-UPSTREAM-BODY' }, 403) });
  await assert.rejects(rejected.load(), (error) => error.status === 403 && !error.message.includes('SECRET-UPSTREAM-BODY'));
  assert.throws(() => createPagesStore({ ...options, token: 'ghp_' + 'a'.repeat(40) }), hasCode('authentication'));
  assert.throws(() => createPagesStore({ ...options, owner: '../other' }), hasCode('connection_invalid'));
});

test('Pages validates documents and deterministic identity before any writes', async () => {
  const { fake, store } = setupPages();
  const invalid = await pagesRecord();
  invalid.pdfBytes.cv = Buffer.from('not a PDF');
  await assert.rejects(store.save(invalid, { requestId: REQUEST }), hasCode('invalid_pdf'));
  const wrong = await pagesRecord(); wrong.editKeyHash = 'a'.repeat(64);
  await assert.rejects(store.save(wrong, { requestId: REQUEST }), hasCode('invalid_record'));
  assert.equal(fake.mutations().length, 0);
});
