// Copies config/*.json -> public/config/ so the served app always reads the
// source-of-truth config. Run automatically before `serve` / `pretest`.
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'config');
const dst = join(root, 'public', 'config');
mkdirSync(dst, { recursive: true });
for (const f of readdirSync(src)) {
  if (f.endsWith('.json')) cpSync(join(src, f), join(dst, f));
}
console.log('config synced ->', dst);
