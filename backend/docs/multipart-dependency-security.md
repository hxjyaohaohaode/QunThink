# Multipart dependency review — 2026-10-10

## Finding and change

The locked production dependency `multer@1.4.5-lts.2` is covered by published upstream denial-of-service advisories. QunThink uses Multer `diskStorage` in the files, agents and groups upload routes. Production mounts authentication before these routes, so this review establishes authenticated upload reachability, not an authentication bypass.

Upgrade only Multer to the exact current stable `2.4.0`. Upstream's supported API retains `diskStorage`, `array`, `single`, `fileFilter` and callback error handling used here. Node 22 satisfies its Node >=10.16 requirement. The lock changes only the Multer resolution and removes its now-unused `concat-stream`, `buffer-from` and `typedarray` packages. No unrelated dependencies or production route behavior were changed.

## Why not stop at 2.0.2?

- [Maintainer advisory GHSA-fjgf-rc76-4x9p](https://github.com/expressjs/multer/security/advisories/GHSA-fjgf-rc76-4x9p): malformed-request DoS affects >=1.4.4-lts.1 and <2.0.2.
- [Maintainer advisory GHSA-72gw-mp4g-v24j](https://github.com/expressjs/multer/security/advisories/GHSA-72gw-mp4g-v24j): deeply nested field DoS affects >=1.0.0 and <2.2.0.
- [Maintainer advisory GHSA-3pph-fpjx-jg34](https://github.com/expressjs/multer/security/advisories/GHSA-3pph-fpjx-jg34): orphaned disk writes on aborted uploads affect >=2.2.0 and <2.4.0, fixed in 2.4.0. This storage mechanism is used by this application.
- [Maintainer changelog](https://github.com/expressjs/multer/blob/main/CHANGELOG.md) and npm registry `latest` both identify 2.4.0 as current stable at review time.

## Regression and audit evidence

`multipart-malformed-security.integration.test.js` sends malformed multipart data to the actual authenticated `/api/files/upload` route. Missing/empty file field names and a truncated file body must return 400, leave no uploaded text file, and keep the health endpoint available. The same test against 1.4.5-lts.2 failed the truncated-upload cleanup assertion (one residual file); against 2.4.0 all three cases passed. Existing upload tests separately exercise successful uploads, validation and access control.

Before the upgrade, Node 22 `npm audit --omit=dev --json` returned no vulnerabilities despite the upstream advisories above. Audit output alone therefore did not justify retaining the old version. Preserve this distinction when reporting: a zero registry audit result is not evidence that every known upstream vulnerability is absent.

## Glob warning

`glob@7.2.3` is transitive through ExcelJS's archiver utilities and unzipper/fstream/rimraf. It remains deprecated technical debt. The [maintainer's CLI command-injection advisory GHSA-5j98-mcp5-4vw2](https://github.com/isaacs/node-glob/security/advisories/GHSA-5j98-mcp5-4vw2) affects >=10.2.0 <10.5.0 or 11.0.x, and only the `-c/--cmd` CLI feature, not version 7.2.3 or the library API. No blanket Glob major override is introduced. This classification does not promise that deprecated software has no other issues.
