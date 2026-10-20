import { build } from 'esbuild';
import { copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'dist');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const name of ['index.html', 'styles.css', 'robots.txt', 'config.json']) {
  await copyFile(resolve(root, 'public', name), resolve(output, name));
}
await writeFile(resolve(output, '.nojekyll'), '');
await build({
  absWorkingDir: root,
  entryPoints: ['public/app.js'],
  outfile: 'dist/app.bundle.js',
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: ['es2022'],
  minify: true,
  sourcemap: false,
  legalComments: 'linked',
});
const size = (await stat(resolve(output, 'app.bundle.js'))).size;
console.log(`Built GitHub Pages site in dist/ (${Math.ceil(size / 1024)} KiB JavaScript).`);
