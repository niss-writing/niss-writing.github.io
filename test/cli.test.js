import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { encodeAccessCode } from '../scripts/access-code.mjs';
import { needsWorkflowScope, publish, releaseFiles } from '../scripts/publish.mjs';

const id = '12345678-1234-4123-8123-123456789abc';
// Deliberately fake token-shaped fixture. No credential is included in this test.
const token = 'github_pat_' + 'a'.repeat(40);
const identity = { owner: 'example-org', repo: `temporary-entry-${id}`, id, token };
const names = [
  'release-files.json', 'package.json', 'package-lock.json',
  'public/index.html', 'public/config.json', 'src/validation.js',
  '.github/workflows/pages.yml', 'scripts/validate-and-merge.mjs',
  'scripts/publish.mjs', 'README.md',
];

async function fixture(t) {
  const directory = await mkdtemp(resolve(tmpdir(), 'temporary-cli-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of names) {
    await mkdir(dirname(resolve(directory, name)), { recursive: true });
    await writeFile(resolve(directory, name), name === 'public/config.json' ? JSON.stringify({ owner: 'example-org' }) : 'fixture\n');
  }
  await writeFile(resolve(directory, 'release-files.json'), JSON.stringify(names));
  return directory;
}

test('access code round-trips the exact one-repository identity without extra fields', () => {
  const code = encodeAccessCode({ ...identity, ignored: 'not included' });
  assert.match(code, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(JSON.parse(Buffer.from(code, 'base64url').toString('utf8')), { v: 1, ...identity });
});

test('access code rejects classic tokens, malformed types, and other repository identities', () => {
  for (const changed of [
    { token: 'ghp_' + 'a'.repeat(40) }, { token: token + '\n' }, { token: { toString: () => token } },
    { token: '' }, { owner: 123 }, { owner: '../example-org' },
    { id: '../../bad' }, { repo: 'another-private-repository' },
    { repo: identity.repo + '/contents' },
  ]) assert.throws(() => encodeAccessCode({ ...identity, ...changed }));
});

test('workflow refresh uses only explicit OAuth scope headers', () => {
  assert.equal(needsWorkflowScope('HTTP/2.0 200 OK\r\nX-OAuth-Scopes: repo, read:org\r\n'), true);
  assert.equal(needsWorkflowScope('HTTP/2.0 200 OK\nx-oauth-scopes: \nx-other: value\n'), true);
  assert.equal(needsWorkflowScope('HTTP/2.0 200 OK\r\nX-OAuth-Scopes: repo, workflow, read:org\r\n'), false);
  assert.equal(needsWorkflowScope('HTTP/2.0 200 OK\nX-OAuth-Scopes: Workflow\n'), false);
  assert.equal(needsWorkflowScope('HTTP/2.0 200 OK\nX-Accepted-OAuth-Scopes: workflow\n'), false);
  assert.equal(needsWorkflowScope('HTTP/2.0 200 OK\n'), false);
});

test('release manifest accepts complete regular source files', async (t) => {
  assert.deepEqual(await releaseFiles(await fixture(t)), names);
});

test('release manifest rejects traversal, nested secrets, and duplicate or missing required files', async (t) => {
  const directory = await fixture(t);
  for (const badName of ['../private.txt', 'public/./index.html', 'src/.env', 'src/.dev.vars', '.private/code.txt', 'src/value.private.txt', '/tmp/file']) {
    await writeFile(resolve(directory, 'release-files.json'), JSON.stringify([...names, badName]));
    await assert.rejects(releaseFiles(directory), /Unsafe release file path/);
  }
  await writeFile(resolve(directory, 'release-files.json'), JSON.stringify([...names, names[0]]));
  await assert.rejects(releaseFiles(directory), /Invalid release file list/);
  const missingRequired = names.filter((name) => name !== 'package-lock.json');
  await writeFile(resolve(directory, 'extra.js'), 'fixture');
  await writeFile(resolve(directory, 'release-files.json'), JSON.stringify([...missingRequired, 'extra.js']));
  await assert.rejects(releaseFiles(directory), /missing package-lock.json/);
});

test('release manifest rejects both file symlinks and symlinked source directories', async (t) => {
  const directory = await fixture(t);
  const outside = await mkdtemp(resolve(tmpdir(), 'temporary-cli-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(resolve(outside, 'validation.js'), 'private data must not be uploaded');
  await rm(resolve(directory, 'src'), { recursive: true });
  await symlink(outside, resolve(directory, 'src'), 'dir');
  await assert.rejects(releaseFiles(directory), /symlink/);
  await rm(resolve(directory, 'src'));
  await mkdir(resolve(directory, 'src'));
  await symlink(resolve(outside, 'validation.js'), resolve(directory, 'src/validation.js'));
  await assert.rejects(releaseFiles(directory), /regular file/);
  await rm(resolve(directory, 'src/validation.js'));
  await writeFile(resolve(directory, 'src/validation.js'), 'fixture');
  await writeFile(resolve(outside, 'manifest.json'), JSON.stringify(names));
  await rm(resolve(directory, 'release-files.json'));
  await symlink(resolve(outside, 'manifest.json'), resolve(directory, 'release-files.json'));
  await assert.rejects(releaseFiles(directory), /regular file/);
});

test('publish dry-run inspects the release without GitHub CLI, git, or repository mutations', async (t) => {
  const directory = await fixture(t);
  const messages = [];
  const before = await readFile(resolve(directory, 'release-files.json'), 'utf8');
  await publish(['example-org/example-org.github.io', '--dry-run'], { directory, log: (message) => messages.push(message) });
  assert.equal(await readFile(resolve(directory, 'release-files.json'), 'utf8'), before);
  assert.match(messages[0], /10 source files/);
  assert.match(messages[1], /No GitHub request/);
});

test('publish rejects ambiguous destinations and mismatched site owner before any command', async (t) => {
  const directory = await fixture(t);
  for (const args of [
    ['example-org/example-org.github.io', 'other/other.github.io', '--dry-run'],
    ['example-org/example-org.github.io', '--force'],
    ['example-org/unrelated', '--dry-run'],
    ['other/other.github.io', '--dry-run'],
  ]) await assert.rejects(publish(args, { directory, log() {} }));
});
