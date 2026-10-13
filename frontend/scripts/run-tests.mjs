import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = (await readdir(new URL('../test/', import.meta.url))).filter(name => name.endsWith('.test.mjs')).sort();
if (!files.length) throw new Error('No frontend tests found');
let next = 0, passed = 0;

// Each file owns a node:test process. Bounded parallelism avoids the Windows
// Node 24 cross-file IPC deserialization failure without disabling assertions.
await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
  while (next < files.length) {
    const name = files[next++];
    const success = await new Promise(resolve => {
      const child = spawn(process.execPath, [fileURLToPath(new URL(`../test/${name}`, import.meta.url))], { cwd: root, env: process.env });
      const output = [];
      child.stdout.on('data', chunk => output.push(chunk));
      child.stderr.on('data', chunk => output.push(chunk));
      child.on('error', error => output.push(Buffer.from(String(error))));
      child.on('close', code => {
        process.stdout.write(`\n[tests] ${name}\n${Buffer.concat(output).toString()}`);
        resolve(code === 0);
      });
    });
    if (success) passed++;
  }
}));
process.stdout.write(`\n[tests] files passed: ${passed}/${files.length}\n`);
process.exitCode = passed === files.length ? 0 : 1;
