import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/check-frontend-audit.mjs', import.meta.url));
const clean = () => ({
  auditReportVersion: 2,
  vulnerabilities: {},
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } },
});
const run = input => spawnSync(process.execPath, [script, '-'], { input, encoding: 'utf8' });
const check = report => run(JSON.stringify(report));

test('accepts a complete zero-findings npm audit v2 report', () => {
  assert.equal(check(clean()).status, 0);
});

test('rejects every severity, including the obsolete React Router exception', () => {
  for (const severity of ['info', 'low', 'moderate', 'high', 'critical']) {
    const report = clean();
    report.vulnerabilities['react-router'] = {
      name: 'react-router', severity,
      via: [{ url: 'https://github.com/advisories/GHSA-qwww-vcr4-c8h2' }],
    };
    report.metadata.vulnerabilities[severity] = 1;
    report.metadata.vulnerabilities.total = 1;
    assert.equal(check(report).status, 1, severity);
  }
});

test('fails closed on incomplete, malformed, or contradictory audit responses', () => {
  const invalid = [null, [], {}, { error: { code: 'ENOAUDIT' } }];
  for (const mutate of [
    r => { delete r.vulnerabilities; },
    r => { r.vulnerabilities = []; },
    r => { delete r.metadata.vulnerabilities.high; },
    r => { r.metadata.vulnerabilities.total = 1; },
    r => { r.metadata.vulnerabilities.high = 1; },
    r => { r.metadata.vulnerabilities.high = '0'; },
    r => { r.metadata.vulnerabilities.high = -1; },
    r => { r.metadata.vulnerabilities.high = 0.5; },
    r => { r.vulnerabilities.braces = { name: 'braces', severity: 'high' }; },
    r => { r.vulnerabilities.braces = null; },
    r => { r.vulnerabilities.braces = { name: 'braces', severity: 'unknown' }; },
    r => { r.error = { code: 'E503' }; },
  ]) {
    const report = clean();
    mutate(report);
    invalid.push(report);
  }
  for (const report of invalid) assert.equal(check(report).status, 2, JSON.stringify(report));
  assert.equal(run('not JSON').status, 2);
});

test('accepts UTF-8 BOM and PowerShell UTF-16LE zero-findings reports', () => {
  const json = JSON.stringify(clean());
  for (const input of [Buffer.from('\ufeff' + json), Buffer.from('\ufeff' + json, 'utf16le')]) {
    assert.equal(run(input).status, 0);
  }
});
