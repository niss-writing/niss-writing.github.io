import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
for (const directory of ['src', 'scripts', 'public']) {
  for (const file of await readdir(resolve(root, directory))) {
    if (!/\.(js|mjs)$/.test(file)) continue;
    const result = spawnSync(process.execPath, ['--check', resolve(root, directory, file)], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
for (const file of ['index.html', 'app.js', 'styles.css']) {
  const text = await readFile(resolve(root, 'public', file), 'utf8');
  if (/\bniss\b|\bstat701\b|\bworkshop\b|\bwriting\b/i.test(text)) throw new Error(`Public branding check failed: ${file}`);
  if (/localStorage|sessionStorage|fetch\(['"]\/api\//.test(text)) throw new Error(`Obsolete API or browser persistence found: ${file}`);
}
const index = await readFile(resolve(root, 'public/index.html'), 'utf8');
if (!index.includes('<title>Temporary for now</title>')) throw new Error('Keep the neutral page title.');
if (!index.includes('./app.bundle.js')) throw new Error('Pages must load the built JavaScript bundle.');
if (!index.includes('https://api.github.com')) throw new Error('The CSP must allow the GitHub API connection.');
const config = JSON.parse(await readFile(resolve(root, 'public/config.json'), 'utf8'));
if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(config.owner) || config.repoPrefix !== 'temporary-entry-' || config.maxFileBytes !== 2097152) throw new Error('Unexpected Pages configuration.');
const workflow = await readFile(resolve(root, '.github/workflows/pages.yml'), 'utf8');
if (!workflow.includes('path: dist') || !workflow.includes('actions/deploy-pages@')) throw new Error('Publish only the built static site.');
console.log('Syntax, neutral branding, browser storage, and GitHub Pages layout checks passed.');
