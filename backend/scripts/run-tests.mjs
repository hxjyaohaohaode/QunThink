import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const testDir = path.resolve('test');
const tests = readdirSync(testDir).filter(name => name.endsWith('.test.js')).sort();
if (!tests.includes('platform.integration.test.js')) throw new Error('platform integration test is missing');

function run(label, args) {
  process.stdout.write(`\n[tests] ${label}\n`);
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(), env: process.env, stdio: 'inherit'
  });
  if (result.error) throw result.error;
  return result.status === 0;
}

// Each node:test file gets its own process and a checked exit status. Node 24
// on Windows has intermittently failed to deserialize test-runner IPC for
// different files even when their assertions pass. Direct execution keeps
// isolation and runs every assertion without that IPC channel.
let passed = 0;
for (const name of tests) {
  if (run(name, [path.join(testDir, name)])) passed++;
}
process.stdout.write(`\n[tests] files passed: ${passed}/${tests.length}\n`);
process.exitCode = passed === tests.length ? 0 : 1;
