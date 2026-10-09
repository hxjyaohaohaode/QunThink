import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseline = JSON.parse(readFileSync(resolve(root, 'scripts/brand-baseline.json'), 'utf8'));
const hash = content => createHash('sha256').update(content).digest('hex');
for (const [path, expected] of Object.entries(baseline.files)) {
  if (hash(readFileSync(resolve(root, path))) !== expected) throw new Error(`Protected brand/entry animation changed: ${path}`);
}
for (const [path, expected] of Object.entries(baseline.inlineLogos)) {
  const source = readFileSync(resolve(root, path), 'utf8');
  const actual = [...source.matchAll(/<svg\b[\s\S]*?<\/svg>/g)].map(m => m[0]).filter(svg => svg.includes('<linearGradient')).map(hash);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Protected inline logo changed: ${path}`);
}
console.log(`Brand verified against ${baseline.baselineCommit}: ${Object.keys(baseline.files).length} exact files and inline logos`);
