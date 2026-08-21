// Copies config/*.json -> public/config/ so the served app always reads the
// source-of-truth config. Run automatically before `serve` / `pretest`.
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'config');
const dst = join(root, 'public', 'config');
mkdirSync(dst, { recursive: true });
for (const f of readdirSync(src)) {
  if (f.endsWith('.json')) cpSync(join(src, f), join(dst, f));
}
// Expose the app version (single source of truth: package.json) so the UI title
// bar can show it. Bumping the version there and rebuilding updates the UI.
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
writeFileSync(join(dst, 'version.json'),
  JSON.stringify({ schemaVersion: 1, name: pkg.name, version: pkg.version }, null, 2) + '\n');
console.log(`config synced -> ${dst} (version ${pkg.version})`);
