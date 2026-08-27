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

if (report.auditReportVersion !== 2 || !report.metadata?.vulnerabilities) {
  console.error('The audit response is not a complete npm audit report; refusing to treat it as a pass.');
  process.exit(2);
}

// The app is a Vite SPA. React Router reports the RSC-only CSRF advisory on
// the latest v7 line, but this app does not use RSC, SSR, framework mode,
// loaders, or actions. Keep this exception exact and fail on anything else.
const allowedPackage = new Set(['react-router', 'react-router-dom']);
const allowedAdvisory = 'https://github.com/advisories/GHSA-qwww-vcr4-c8h2';
const unexpected = [];

for (const [name, vulnerability] of Object.entries(report.vulnerabilities)) {
  if (!allowedPackage.has(name) || vulnerability.severity !== 'high') {
    unexpected.push(`${name} (${vulnerability.severity})`);
    continue;
  }
  for (const item of vulnerability.via ?? []) {
    if (typeof item === 'string') {
      if (item !== 'react-router') unexpected.push(`${name}: ${item}`);
    } else if (item.url !== allowedAdvisory) {
      unexpected.push(`${name}: ${item.url ?? item.title ?? 'unknown advisory'}`);
    }
  }
}

const counts = report.metadata.vulnerabilities;
if (counts.critical > 0 || counts.moderate > 0 || counts.low > 0 || counts.info > 0 || unexpected.length > 0) {
  console.error('Unexpected frontend dependency audit findings:');
  console.error(JSON.stringify({ counts, unexpected }, null, 2));
  process.exit(1);
}

console.log('Frontend audit gate passed: only the documented React Router RSC-only advisory remains.');
