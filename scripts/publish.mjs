import { spawnSync } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const gitAuth = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options });
  if (result.error) throw new Error(`${command} is required. Install it and run this command again.`);
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error((result.stderr || result.stdout || `${command} failed.`).trim());
  }
  return result;
}

function api(endpoint, method = 'GET', body) {
  const args = ['api', '--hostname', 'github.com', endpoint, '--method', method, '-H', 'Accept: application/vnd.github+json'];
  if (body !== undefined) args.push('--input', '-');
  return run('gh', args, { input: body === undefined ? undefined : JSON.stringify(body) });
}

// A missing header is normal for fine-grained tokens; it is not proof of a
// missing scope. Only an explicit OAuth scope list can trigger a refresh.
export function needsWorkflowScope(headers) {
  const scopes = /^x-oauth-scopes:[ \t]*([^\r\n]*)/im.exec(headers);
  return scopes !== null && !scopes[1].split(',').map((value) => value.trim().toLowerCase()).includes('workflow');
}

export async function releaseFiles(directory = root) {
  if (!(await lstat(resolve(directory, 'release-files.json'))).isFile()) throw new Error('The release file list must be a regular file.');
  const files = JSON.parse(await readFile(resolve(directory, 'release-files.json'), 'utf8'));
  if (!Array.isArray(files) || files.length < 10 || files.length > 150 || new Set(files).size !== files.length) throw new Error('Invalid release file list.');
  for (const name of files) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9_.\/-]+$/.test(name) || name.startsWith('/') || name.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git' || part === 'node_modules' || part === '.private' || /^\.env(?:\.|$)|^\.dev\.vars(?:\.|$)/.test(part)) || /\.private\./.test(name)) throw new Error('Unsafe release file path.');
    const path = resolve(directory, name);
    if (!path.startsWith(resolve(directory) + sep) || !(await lstat(path)).isFile()) throw new Error(`Release file is missing or not a regular file: ${name}`);
    for (const part of name.split('/').map((_, index, all) => all.slice(0, index + 1).join('/'))) {
      if ((await lstat(resolve(directory, part))).isSymbolicLink()) throw new Error(`Release path contains a symlink: ${part}`);
    }
  }
  for (const required of ['package.json', 'package-lock.json', 'public/index.html', '.github/workflows/pages.yml', 'scripts/validate-and-merge.mjs', 'release-files.json']) {
    if (!files.includes(required)) throw new Error(`Release file list is missing ${required}.`);
  }
  return files;
}

export async function publish(args = process.argv.slice(2), { directory = root, log = console.log } = {}) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string') || args.filter((arg) => !arg.startsWith('--')).length > 1) throw new Error('Use one owner/repository destination.');
  const target = args.find((arg) => !arg.startsWith('--')) || 'niss-writing/niss-writing.github.io';
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(target)) throw new Error('Use an owner/repository destination.');
  if (args.some((arg) => arg.startsWith('--') && arg !== '--dry-run')) throw new Error('The only optional flag is --dry-run.');
  const [owner, name] = target.split('/');
  if (name.toLowerCase() !== `${owner.toLowerCase()}.github.io`) throw new Error('This release targets the organization site: OWNER/OWNER.github.io.');
  const files = await releaseFiles(directory);
  const config = JSON.parse(await readFile(resolve(directory, 'public/config.json'), 'utf8'));
  if (typeof config.owner !== 'string' || config.owner.toLowerCase() !== owner.toLowerCase()) throw new Error('Set public/config.json owner to match this destination first.');
  if (args.includes('--dry-run')) {
    log(`Ready to upload ${files.length} source files to ${target}, enable GitHub Pages, and run pages.yml.`);
    log('Dry run only. No GitHub request, repository change, or deployment was made.');
    return;
  }
  run('git', ['--version']);
  run('gh', ['--version']);
  const auth = run('gh', ['auth', 'status', '--hostname', 'github.com'], { allowFailure: true });
  if (auth.status !== 0) {
    console.log('Sign in to GitHub CLI with the account that manages this organization.');
    run('gh', ['auth', 'login', '--hostname', 'github.com', '--web', '--git-protocol', 'https', '--scopes', 'repo,workflow'], { stdio: 'inherit' });
  }
  const scopeArgs = ['api', '--hostname', 'github.com', 'user', '--include', '--silent'];
  if (needsWorkflowScope(run('gh', scopeArgs).stdout)) {
    if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) throw new Error('The token supplied through GH_TOKEN or GITHUB_TOKEN lacks the workflow scope. Update that credential, or unset it and rerun using your stored GitHub CLI login.');
    console.log('GitHub needs the workflow scope to upload the included deployment workflow. Refreshing your existing CLI authorization.');
    run('gh', ['auth', 'refresh', '--hostname', 'github.com', '--scopes', 'workflow'], { stdio: 'inherit' });
    if (needsWorkflowScope(run('gh', scopeArgs).stdout)) throw new Error('The workflow scope was not granted. Rerun gh auth refresh -h github.com -s workflow before publishing.');
  }
  let repository;
  try { repository = JSON.parse(api(`repos/${target}`).stdout); }
  catch { throw new Error(`Cannot access ${target}. Check that it exists and that your gh login has access. No new repository was created.`); }
  if (typeof repository.full_name !== 'string' || repository.full_name.toLowerCase() !== target.toLowerCase() || repository.archived || repository.disabled || repository.fork) throw new Error('The destination must be the active organization website repository.');
  if (repository.private) throw new Error('This website source must be public so the private validation workflows can fetch their pinned validator. Make the intended website repository public, then rerun.');
  if (!repository.permissions?.push) throw new Error('Your GitHub CLI account does not have push access to this repository.');
  const branch = repository.default_branch || 'main';
  if (!/^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$/.test(branch) || branch.includes('..')) throw new Error('Unsupported default branch name.');
  const checkout = await mkdtemp(resolve(tmpdir(), 'temporary-pages-'));
  console.log(`Preparing ${target} on its ${branch} branch.`);
  run('git', [...gitAuth, 'clone', '--quiet', `https://github.com/${target}.git`, checkout]);
  const hasHead = run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: checkout, allowFailure: true }).status === 0;
  if (!hasHead) run('git', ['checkout', '-B', branch], { cwd: checkout });
  const git = (arguments_, options = {}) => run('git', arguments_, { cwd: checkout, ...options });
  const workflows = resolve(checkout, '.github/workflows');
  let existingWorkflows = [];
  try { existingWorkflows = await readdir(workflows, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const entry of existingWorkflows) {
    if (entry.isFile() && /\.ya?ml$/i.test(entry.name) && entry.name !== 'pages.yml' && /uses:\s*actions\/deploy-pages@/.test(await readFile(resolve(workflows, entry.name), 'utf8'))) {
      throw new Error(`Another Pages deployment workflow exists at .github/workflows/${entry.name}. Consolidate the deployment workflows before rerunning; no source was pushed. Checkout: ${checkout}`);
    }
  }
  for (const path of files) {
    // Never follow a destination symlink from a pre-existing checkout.
    for (const part of path.split('/').map((_, index, all) => all.slice(0, index + 1).join('/'))) {
      try { if ((await lstat(resolve(checkout, part))).isSymbolicLink()) throw new Error(`Destination contains a symlink at ${part}; inspect it before uploading.`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await mkdir(dirname(resolve(checkout, path)), { recursive: true });
    await copyFile(resolve(directory, path), resolve(checkout, path));
  }
  git(['add', '--', ...files]);
  const changes = git(['diff', '--cached', '--quiet'], { allowFailure: true });
  if (changes.status !== 0 && changes.status !== 1) throw new Error(`Could not inspect the prepared changes. Checkout: ${checkout}`);
  if (changes.status !== 0) {
    const user = JSON.parse(api('user').stdout);
    // Commit-local fallback only; do not edit the user's global Git identity.
    const identity = [];
    if (!git(['config', 'user.name'], { allowFailure: true }).stdout.trim()) identity.push('-c', `user.name=${user.login}`);
    if (!git(['config', 'user.email'], { allowFailure: true }).stdout.trim()) identity.push('-c', `user.email=${user.id}+${user.login}@users.noreply.github.com`);
    git([...identity, 'commit', '-m', 'Add temporary GitHub Pages submission prototype']);
    try { git([...gitAuth, 'push', 'origin', `HEAD:refs/heads/${branch}`]); }
    catch (error) { throw new Error(`${error.message}\nThe prepared commit is in ${checkout}. No force push was attempted. If GitHub reports a missing workflow scope, run gh auth refresh -h github.com -s workflow, then rerun.`); }
  } else console.log('The source files are already up to date.');
  let pages;
  try { pages = JSON.parse(api(`repos/${target}/pages`).stdout); }
  catch { pages = null; }
  try {
    if (pages) api(`repos/${target}/pages`, 'PUT', { build_type: 'workflow' });
    else api(`repos/${target}/pages`, 'POST', { build_type: 'workflow' });
  } catch {
    throw new Error(`Source uploaded. GitHub did not allow the Pages configuration change. In https://github.com/${target}/settings/pages, set Source to GitHub Actions, then run pages.yml. Prepared checkout: ${checkout}`);
  }
  try { api(`repos/${target}/actions/workflows/pages.yml/dispatches`, 'POST', { ref: branch }); }
  catch { throw new Error(`Source uploaded and Pages enabled. Start the Publish GitHub Pages workflow at https://github.com/${target}/actions/workflows/pages.yml. Its first push run may already be running.`); }
  console.log(`Source uploaded and the Pages deployment requested: https://${owner.toLowerCase()}.github.io/`);
  console.log(`Watch deployment: https://github.com/${target}/actions/workflows/pages.yml`);
  console.log(`Prepared checkout: ${checkout}`);
  console.log('The URL becomes live when the deployment succeeds. Private tester repositories are prepared separately with scripts/provision.mjs.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  publish().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
