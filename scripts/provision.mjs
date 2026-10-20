import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SHA = /^[0-9a-f]{40}$/;
const ACCOUNT = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const SOURCE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const templateURL = new URL('../templates/private-submission/.github/workflows/validate-submission.yml', import.meta.url);

function runGh(args, { input } = {}) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8', input, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GH_HOST: 'github.com', GH_DEBUG: '' },
  });
  if (result.error?.code === 'ENOENT') throw new Error('Install the GitHub CLI and run gh auth login first.');
  if (result.error || result.status !== 0) {
    const match = result.stderr?.match(/HTTP\s+(\d{3})/);
    const error = new Error(match ? `GitHub refused the setup operation (HTTP ${match[1]}).` : 'The GitHub CLI could not complete setup. Check gh auth status and your repository permissions.');
    if (match) error.status = Number(match[1]);
    // Never forward arbitrary CLI debug output, credentials, or API bodies.
    throw error;
  }
  return result.stdout;
}

export function renderPrivateWorkflow(template, values) {
  let result = template;
  for (const [key, value] of Object.entries(values)) result = result.split(`__${key}__`).join(String(value));
  if (/__[A-Z][A-Z_]+__/.test(result)) throw new Error('The private workflow template has an unresolved setting.');
  return result;
}

/** Organizer-only CLI setup. All credentials stay with gh; none are generated,
 * committed, printed, or handed to a browser by this helper. */
export async function provision(options, {
  run = runGh,
  uuid = randomUUID,
  sleep = delay,
  readTemplate = () => readFile(templateURL, 'utf8'),
} = {}) {
  const owner = options.owner;
  if (!ACCOUNT.test(owner || '')) throw new Error('Supply the GitHub owner or organization name.');
  const source = options.source || `${owner}/${owner}.github.io`;
  if (!SOURCE.test(source)) throw new Error('--source must be OWNER/REPOSITORY.');
  const sourceOwner = source.split('/')[0];
  const sourceName = source.split('/')[1];
  const defaultURL = `https://${sourceOwner}.github.io/${sourceName.toLowerCase() === `${sourceOwner.toLowerCase()}.github.io` ? '' : `${sourceName}/`}`;
  const site = new URL(options.siteURL || defaultURL);
  if (site.protocol !== 'https:' || site.username || site.password || site.search || site.hash) {
    throw new Error('--site-url must be a plain HTTPS website address.');
  }
  const id = uuid();
  if (!UUID.test(id)) throw new Error('A valid random submission identity could not be generated.');
  const name = `temporary-entry-${id}`;
  const fullName = `${owner}/${name}`;
  const root = `/repos/${owner}/${name}`;
  let created = false;
  const warnings = [];

  async function api(path, { method = 'GET', body } = {}) {
    const args = ['api', '--hostname', 'github.com', path, '--method', method];
    if (body !== undefined) args.push('--input', '-');
    const output = await run(args, { input: body === undefined ? undefined : JSON.stringify(body) });
    return output.trim() ? JSON.parse(output) : null;
  }

  try {
    // Resolve a trusted immutable public revision BEFORE provisioning anything.
    const sourceRepo = await api(`/repos/${source}`);
    if (sourceRepo.private !== false || sourceRepo.full_name?.toLowerCase() !== source.toLowerCase()) {
      throw new Error('The trusted website source must already exist as the specified public GitHub repository. Publish the website first.');
    }
    const sourceCommit = await api(`/repos/${source}/commits/${encodeURIComponent(sourceRepo.default_branch)}`);
    if (!SHA.test(sourceCommit.sha || '') || !SHA.test(sourceCommit.commit?.tree?.sha || '')) throw new Error('The public source commit could not be verified.');
    const sourceTree = await api(`/repos/${source}/git/trees/${sourceCommit.commit.tree.sha}?recursive=1`);
    const needed = ['scripts/validate-and-merge.mjs', 'src/validation.js', 'package.json', 'package-lock.json'];
    if (sourceTree.truncated !== false || !Array.isArray(sourceTree.tree) || needed.some((path) =>
      !sourceTree.tree.some((entry) => entry.path === path && entry.type === 'blob' && ['100644', '100755'].includes(entry.mode)))) {
      throw new Error('The published source is missing the validator or its locked dependencies. Upload this complete project before provisioning.');
    }
    const template = await readTemplate();
    const ownerProfile = await api(`/users/${owner}`);
    if (!['User', 'Organization'].includes(ownerProfile.type) || ownerProfile.login?.toLowerCase() !== owner.toLowerCase()) {
      throw new Error('The target GitHub account could not be verified.');
    }
    if (ownerProfile.type === 'User') {
      const authenticated = await api('/user');
      if (authenticated.login?.toLowerCase() !== owner.toLowerCase()) {
        throw new Error('Creating a personal repository requires gh to be logged into that same owner account.');
      }
    }
    const repo = await api(ownerProfile.type === 'Organization' ? `/orgs/${owner}/repos` : '/user/repos', {
      method: 'POST', body: {
        name, private: true, auto_init: true,
        description: 'Private temporary submission storage',
        has_issues: false, has_projects: false, has_wiki: false,
        allow_squash_merge: true, delete_branch_on_merge: false,
      },
    });
    created = true;
    if (repo.private !== true || repo.full_name?.toLowerCase() !== fullName.toLowerCase() ||
        !Number.isSafeInteger(repo.id) || repo.id <= 0) {
      throw new Error('The created repository was not confirmed private with the expected identity. Do not issue an access code.');
    }
    let initial;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        initial = await api(`${root}/git/ref/heads/${encodeURIComponent(repo.default_branch)}`);
        break;
      } catch (error) {
        if (![404, 409].includes(error.status) || attempt === 3) throw error;
        await sleep(1000);
      }
    }
    if (!SHA.test(initial?.object?.sha || '')) throw new Error('GitHub has not finished initializing the new repository.');
    if (repo.default_branch !== 'main') {
      await api(`${root}/git/refs`, { method: 'POST', body: { ref: 'refs/heads/main', sha: initial.object.sha } });
      await api(root, { method: 'PATCH', body: { default_branch: 'main' } });
    }
    const manifest = { schemaVersion: 2, id, repositoryId: repo.id, owner, name, defaultBranch: 'main' };
    const workflow = renderPrivateWorkflow(template, {
      SOURCE_REPOSITORY: source,
      SOURCE_SHA: sourceCommit.sha,
      SUBMISSION_ID: id,
      REPOSITORY_ID: repo.id,
      OWNER: owner,
      REPOSITORY_NAME: name,
    });
    const readme = '# Private submission\n\nThis repository stores one person’s submission. Use the assigned private access code on the submission page to add or update the two PDFs and information.\n\nThe submission package is `cv.pdf`, `sample.pdf`, and `submission.md`. Revisions use the `submission` branch and a pull request. Its validation workflow runs code from a pinned commit in the separate public website repository; it never executes code from this repository.\n\nDo not add secrets or personal access tokens to files, issues, pull requests, or workflow settings.\n';
    const files = new Map([
      ['README.md', readme],
      ['.submission-config.json', `${JSON.stringify(manifest, null, 2)}\n`],
      ['.github/workflows/validate-submission.yml', workflow],
    ]);
    const baseCommit = await api(`${root}/git/commits/${initial.object.sha}`);
    if (!SHA.test(baseCommit.tree?.sha || '')) throw new Error('The initial repository tree could not be verified.');
    const entries = [];
    for (const [path, content] of files) {
      const blob = await api(`${root}/git/blobs`, { method: 'POST', body: { content, encoding: 'utf-8' } });
      if (!SHA.test(blob.sha || '')) throw new Error('GitHub did not return a valid setup file hash.');
      entries.push({ path, type: 'blob', mode: '100644', sha: blob.sha });
    }
    const tree = await api(`${root}/git/trees`, { method: 'POST', body: { base_tree: baseCommit.tree.sha, tree: entries } });
    const commit = await api(`${root}/git/commits`, {
      method: 'POST', body: { message: 'Initialize private submission storage', tree: tree.sha, parents: [initial.object.sha] },
    });
    if (!SHA.test(commit.sha || '')) throw new Error('GitHub did not return a valid setup commit.');
    await api(`${root}/git/refs/heads/main`, { method: 'PATCH', body: { sha: commit.sha, force: false } });
    const checked = await api(root);
    if (checked.id !== repo.id || checked.private !== true || checked.default_branch !== 'main') {
      throw new Error('Final repository privacy and identity could not be confirmed. Do not issue an access code.');
    }

    try {
      await api(`${root}/actions/permissions/workflow`, {
        method: 'PUT', body: { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false },
      });
    } catch {
      warnings.push('The default Actions token policy could not be updated. The installed workflow declares its own minimal write permissions; check organization Actions policies if it does not run.');
    }
    let protection = 'not-enabled';
    if (options.protect !== false) {
      try {
        await api(`${root}/branches/main/protection`, {
          method: 'PUT', body: {
            required_status_checks: null,
            enforce_admins: true,
            required_pull_request_reviews: {
              dismiss_stale_reviews: true, require_code_owner_reviews: false, required_approving_review_count: 0,
            },
            restrictions: null, allow_force_pushes: false, allow_deletions: false,
          },
        });
        protection = 'enabled';
      } catch {
        warnings.push('Main branch protection was not enabled. Private-repository protection can require a paid GitHub plan or additional administrator permissions. The form still submits PRs, but this participant’s scoped credential can also write or merge its own repository directly. The public website and pinned workflow source remain separate.');
      }
    } else {
      warnings.push('Main branch protection was explicitly skipped; the participant credential can write its own repository directly.');
    }
    const tokenURL = new URL('https://github.com/settings/personal-access-tokens/new');
    tokenURL.search = new URLSearchParams({
      name: `Temporary submission ${id.slice(0, 8)}`, target_name: owner,
      description: 'Access to one private temporary submission repository only',
      expires_in: '30', contents: 'write', pull_requests: 'write',
    }).toString();
    return { id, owner, repo: name, repositoryId: repo.id, fullName,
      repositoryURL: `https://github.com/${fullName}`, siteURL: site.href,
      source, sourceSHA: sourceCommit.sha, protection, warnings,
      tokenURL: tokenURL.href, accessCommand: `node scripts/access-code.mjs ${fullName}` };
  } catch (error) {
    if (created) error.message += ` Setup is incomplete for https://github.com/${fullName}. No participant credential was created or issued. Inspect this private repository before using it.`;
    throw error;
  }
}

function argumentsForCLI(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (value === '--help' || value === '-h') return { help: true };
    if (value === '--source') options.source = args[++i];
    else if (value === '--site-url') options.siteURL = args[++i];
    else if (value === '--no-protection') options.protect = false;
    else if (!value.startsWith('-') && !options.owner) options.owner = value;
    else throw new Error(`Unknown setup argument: ${value}`);
  }
  return options;
}

async function main() {
  try {
    const options = argumentsForCLI(process.argv.slice(2));
    if (options.help || !options.owner) {
      console.log('Usage: node scripts/provision.mjs OWNER [--source OWNER/SITE_REPOSITORY] [--site-url HTTPS_URL] [--no-protection]');
      console.log('Creates one private submission repository using your existing gh login. Publish the public website first.');
      if (!options.help) process.exitCode = 1;
      return;
    }
    const result = await provision(options);
    console.log(`Private submission repository ready: ${result.repositoryURL}`);
    console.log(`Website: ${result.siteURL}`);
    console.log(`Trusted validator revision: ${result.source}@${result.sourceSHA}`);
    console.log(`Main branch protection: ${result.protection}`);
    for (const warning of result.warnings) console.log(`Setup note: ${warning}`);
    console.log('\nNext, create ONE fine-grained personal access token for this repository only:');
    console.log(result.tokenURL);
    console.log(`Select “Only select repositories” and ONLY ${result.repo}.`);
    console.log('Allow Contents: read/write and Pull requests: read/write. Do not grant Workflows, Administration, or access to other repositories.');
    console.log('The token cannot be created by this helper. Keep it private and give it a short expiration.');
    console.log('\nThen generate this participant’s private access code:');
    console.log(result.accessCommand);
  } catch (error) {
    console.error(error.message || 'Private repository setup failed.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
