import { chmod, lstat, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function encodeAccessCode({ owner, repo, id, token }) {
  if (typeof owner !== 'string' || typeof repo !== 'string' || typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) || repo !== `temporary-entry-${id}`) throw new Error('Invalid private submission identity.');
  if (typeof token !== 'string' || !/^github_pat_[A-Za-z0-9_]{20,255}$/.test(token)) throw new Error('Use a fine-grained personal access token limited to this one repository. Classic tokens are not accepted; the helper cannot inspect a fine-grained token\'s full scope.');
  return Buffer.from(JSON.stringify({ v: 1, owner, repo, id, token }), 'utf8').toString('base64url');
}

async function hiddenToken() {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') throw new Error('Run this helper in an interactive terminal so the token can be entered without echo.');
  process.stdout.write('Paste the one-repository fine-grained token (hidden), then press Enter: ');
  return new Promise((resolveToken, reject) => {
    let value = '';
    let finished = false;
    const wasRaw = Boolean(process.stdin.isRaw);
    const finish = (error) => {
      if (finished) return;
      finished = true;
      process.stdin.off('data', onData);
      process.stdin.off('error', onError);
      process.stdin.off('end', onEnd);
      process.off('SIGINT', onEnd);
      process.off('SIGTERM', onEnd);
      try { process.stdin.setRawMode(wasRaw); } catch { /* The terminal may already be closed. */ }
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error); else resolveToken(value.trim());
      value = '';
    };
    const onError = () => finish(new Error('Could not read the hidden token from this terminal.'));
    const onEnd = () => finish(new Error('Cancelled.'));
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\u0003' || character === '\u0004') { finish(new Error('Cancelled.')); return; }
        if (character === '\r' || character === '\n') { finish(); return; }
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (character === '\u0015') value = '';
        else if (/^[A-Za-z0-9_ ]$/.test(character)) value += character;
        else { finish(new Error('The token contains unsupported characters. Paste the token itself, without terminal formatting.')); return; }
        if (value.length > 300) { finish(new Error('That value is too long to be an access token.')); return; }
      }
    };
    process.stdin.on('error', onError);
    process.stdin.on('end', onEnd);
    process.on('SIGINT', onEnd);
    process.on('SIGTERM', onEnd);
    process.stdin.on('data', onData);
    try {
      process.stdin.setRawMode(true);
      process.stdin.setEncoding('utf8');
      process.stdin.resume();
    } catch { onError(); }
  });
}

export async function createCode(target = process.argv[2]) {
  const match = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/(temporary-entry-([0-9a-f-]{36}))$/.exec(target || '');
  if (!match) throw new Error('Usage: node scripts/access-code.mjs OWNER/temporary-entry-UUID');
  const [, owner, repo, id] = match;
  const token = await hiddenToken();
  const code = encodeAccessCode({ owner, repo, id, token });
  const request = async (path) => {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}${path}`, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
      redirect: 'error', signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`GitHub did not accept this token for the private repository (${response.status}). Check its selected repository, expiry, and organization approval.`);
    return response.json();
  };
  const repository = await request('');
  if (!repository || repository.private !== true || !Number.isSafeInteger(repository.id) || repository.id <= 0 || typeof repository.full_name !== 'string' || repository.full_name.toLowerCase() !== target.toLowerCase() || repository.default_branch !== 'main' || repository.archived || repository.fork || repository.disabled) throw new Error('The destination is not the expected active private repository.');
  const file = await request('/contents/.submission-config.json?ref=main');
  if (!file || file.type !== 'file' || file.encoding !== 'base64' || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 4096 || typeof file.content !== 'string' || file.content.length > 6000 || !/^[A-Za-z0-9+/=\r\n]+$/.test(file.content)) throw new Error('The repository has not been prepared with the provisioning helper.');
  const bytes = Buffer.from(file.content, 'base64');
  if (bytes.length !== file.size) throw new Error('The repository identity file is incomplete.');
  let manifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('The repository identity file is not valid JSON.'); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || Object.keys(manifest).length !== 6 || manifest.schemaVersion !== 2 || manifest.id !== id || manifest.repositoryId !== repository.id || typeof manifest.owner !== 'string' || manifest.owner.toLowerCase() !== owner.toLowerCase() || manifest.name !== repo || manifest.defaultBranch !== 'main') throw new Error('The repository identity does not match this access code.');
  const directory = resolve(import.meta.dirname, '../.private');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(directory);
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) throw new Error('The private code folder must be a real directory, not a symlink.');
  await chmod(directory, 0o700);
  const path = resolve(directory, `${id}.private.txt`);
  await writeFile(path, code + '\n', { mode: 0o600, flag: 'wx' });
  console.log(`Saved private access code: ${path}`);
  console.log('Share the contents privately with this tester. They paste it into Enter access code on the page.');
  console.log('This code grants access to their private repository until its token expires or is revoked. Keep it out of commits, public issues, and shared logs.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  createCode().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
