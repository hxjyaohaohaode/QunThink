import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { docxFixture } from './helpers/docxFixture.js';

const require = createRequire(import.meta.url);
const mammothRoot = path.dirname(require.resolve('mammoth/package.json'));
const argparseRequire = createRequire(path.join(mammothRoot, 'package.json'));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qunthink-docx-cli-'));
const input = path.join(workDir, 'input-%.101f.docx');
fs.writeFileSync(input, docxFixture('CLI Unicode 群想'));
const childEnv = { PATH: process.env.PATH, HOME: workDir, USERPROFILE: workDir,
  TEMP: workDir, TMP: workDir, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };

test.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

function runNode(args) {
  const result = spawnSync(process.execPath, ['--max-old-space-size=96', ...args], {
    cwd: workDir, env: childEnv, encoding: 'utf8', timeout: 5000, maxBuffer: 128 * 1024
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}

function cli(args, status = 0) {
  const result = runNode([path.join(mammothRoot, 'bin/mammoth'), ...args]);
  assert.equal(result.status, status, result.stderr);
  return result;
}

test('official Mammoth and scoped argparse dependency versions exclude the vulnerable sprintf package', () => {
  assert.equal(require('mammoth/package.json').version, '1.13.0');
  assert.equal(argparseRequire('argparse/package.json').version, '2.0.1');
  assert.equal(argparseRequire('argparse/package.json').dependencies, undefined);
  assert.throws(() => argparseRequire.resolve('sprintf-js'), { code: 'MODULE_NOT_FOUND' });
});

test('argparse 2 uses a limited formatter that does not interpret floating-point precision payloads', () => {
  const sub = argparseRequire('argparse/lib/sub');
  assert.equal(sub('%s', 'plain'), 'plain');
  assert.equal(sub('%(name)s', { name: '群想' }), '群想');
  for (const format of ['%.101f', '%.101e', '%.101g', '%.0g']) {
    // Help templates receive a mapping. Precision strings remain literal.
    assert.equal(sub(format, {}), format);
    // A numeric argument to this unsupported syntax is rejected as TypeError,
    // never forwarded as a precision parameter to toFixed/toExponential/etc.
    assert.throws(() => sub(format, 1), error => error instanceof TypeError && !(error instanceof RangeError));
  }
});

test('Mammoth CLI retains argument success/failure behavior and document output with argparse 2 compatibility aliases', () => {
  assert.match(cli(['--help']).stdout, /--output-format/);
  assert.match(cli([], 2).stderr, /required/);
  assert.equal(cli([input]).stdout, '<p>CLI Unicode 群想</p>');
  assert.equal(cli([input, '--output-format', 'markdown']).stdout.trim(), 'CLI Unicode 群想');
  assert.match(cli([input, '--output-format', 'invalid'], 2).stderr, /invalid choice/);
  assert.match(cli([input, '--unknown'], 2).stderr, /unrecognized arguments/);
  const output = path.join(workDir, 'output.html');
  assert.equal(cli([input, output]).stdout, '');
  assert.equal(fs.readFileSync(output, 'utf8'), '<p>CLI Unicode 群想</p>');
  const outputDir = path.join(workDir, 'out');
  fs.mkdirSync(outputDir);
  cli([input, '--output-dir', outputDir]);
  assert.equal(fs.readFileSync(path.join(outputDir, 'input-%.101f.html'), 'utf8'), '<p>CLI Unicode 群想</p>');
  assert.match(cli([input, output, '--output-dir', outputDir], 2).stderr, /not allowed with/);
  const style = path.join(workDir, 'style.txt');
  fs.writeFileSync(style, 'p => h1');
  assert.equal(cli([input, '--style-map', style]).stdout, '<h1>CLI Unicode 群想</h1>');
  assert.match(cli([path.join(workDir, 'missing.docx')], 2).stderr, /ENOENT/);
});

test('upstream unterminated-string regression terminates under a process memory and time bound', () => {
  const tokeniser = path.join(mammothRoot, 'lib/styles/parser/tokeniser.js');
  const result = runNode(['-e', `
    const assert = require('node:assert/strict');
    const tokenise = require(${JSON.stringify(tokeniser)}).tokenise;
    const escapes = '\\\\a'.repeat(50);
    const tokens = tokenise("'" + escapes);
    assert.equal(tokens[0].name, 'unterminated-string');
    assert.equal(tokens[0].value, escapes);
    assert.equal(tokens[1].name, 'end');
    console.log('bounded-tokeniser-pass');
  `]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'bounded-tokeniser-pass');
});
