import fs from 'node:fs';

const reportPath = process.argv[2];
if (!reportPath) {
  console.error('Usage: node scripts/check-frontend-audit.mjs <npm-audit-json>');
  process.exit(2);
}

let report;
try {
  const bytes = reportPath === '-' ? fs.readFileSync(0) : fs.readFileSync(reportPath);
  // PowerShell redirects text as UTF-16LE; npm's CI output is UTF-8.
  const raw = bytes[0] === 0xff && bytes[1] === 0xfe
    ? bytes.toString('utf16le')
    : bytes.toString('utf8');
  report = JSON.parse(raw.replace(/^\uFEFF/, ''));
} catch (error) {
  console.error(`Cannot read npm audit JSON: ${error.message}`);
  process.exit(2);
}

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const severities = ['info', 'low', 'moderate', 'high', 'critical'];
const counts = report?.metadata?.vulnerabilities;
const findings = report?.vulnerabilities;
const invalidReport = () => {
  console.error('The audit response is not a complete, consistent npm audit report; refusing to treat it as a pass.');
  process.exit(2);
};

if (!isRecord(report) || report.error || report.auditReportVersion !== 2 ||
    !isRecord(counts) || !isRecord(findings)) invalidReport();

for (const key of [...severities, 'total']) {
  if (!Number.isSafeInteger(counts[key]) || counts[key] < 0) invalidReport();
}
const observed = Object.fromEntries(severities.map(severity => [severity, 0]));
for (const [name, finding] of Object.entries(findings)) {
  if (!isRecord(finding) || finding.name !== name || !severities.includes(finding.severity)) invalidReport();
  observed[finding.severity]++;
}
if (severities.some(severity => counts[severity] !== observed[severity]) ||
    counts.total !== Object.keys(findings).length) invalidReport();

// Production dependencies currently have no reported advisories. Do not retain
// historical package exceptions: a new finding must fail closed for review.
if (counts.total > 0) {
  console.error('Frontend production dependency vulnerabilities reported:');
  console.error(JSON.stringify({ counts, packages: Object.keys(findings) }, null, 2));
  process.exit(1);
}
console.log('Frontend audit gate passed: no production dependency vulnerabilities reported.');
