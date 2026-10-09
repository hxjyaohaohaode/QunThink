# Frontend build dependency review, 2026-10-09

## Minimal selector-parser fix

The frontend pins an npm override for `postcss-selector-parser` to `7.1.6`.
This is the upstream fix for [GHSA-rj75-hqrm-r3gf](https://github.com/advisories/GHSA-rj75-hqrm-r3gf),
which replaces quadratic index-array scans with Set membership in flat selector parsing.
Both Tailwind CSS 3.4.19 and its postcss-nested 6.2.0 dependency resolve this one version.
Tailwind itself, application code, styling configuration, brand assets and audit policy are unchanged.

The override crosses the consumers' declared parser 6.x ranges. Parser 7.0 changed insertion-during-iteration
behavior, so this is a reviewed compatibility override, not an ordinary in-range patch update.
The compatibility test checks the resolved version, selector round trips, nested CSS and representative
Tailwind variants. A future override update or removal needs an explicit compatibility review and updated
version assertions. Remove the override once the retained consumers declare a fixed compatible release.

Before publication, run the complete frontend tests, type check/build, brand gate and both audit scopes:

```sh
cd frontend
npm ci
npm test
npm run build
npm audit --omit=dev --registry=https://registry.npmjs.org
npm audit --registry=https://registry.npmjs.org
cd ..
node scripts/verify-brand.mjs
```

For this candidate, fresh Node 24.19.0 baseline/candidate builds produced 30 byte-identical files,
including CSS, JavaScript, HTML and PWA outputs. An additional corpus of 122 Tailwind class requests
and 1,382 selectors produced identical generated CSS and parser AST/serialization. These checks are
evidence for this repository; they do not establish universal parser 6/7 compatibility or replace
the supported-runtime and browser gates.

## Remaining braces finding

The full development audit remains nonzero: five high-severity affected package nodes refer to one
independent [braces advisory, GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
The affected nodes are braces, chokidar, micromatch, fast-glob and Tailwind. They are not five independent
vulnerabilities. npm's production-only audit reports zero findings. No audit is suppressed or reclassified.

As verified on 2026-10-09, npm's latest braces release is 3.0.3 and the advisory lists no patched release.
An arbitrary override cannot repair it. npm's suggested Tailwind 4 upgrade is a major CSS/build migration,
so it is not applied as a dependency-only change.

The installed build chain reaches braces through Tailwind's configured content-file patterns:
Tailwind `parseCandidateFiles` -> fast-glob task generation -> micromatch brace expansion -> braces.
The Tailwind CLI watch path additionally passes configured patterns/dependency paths to chokidar 3,
which expands brace-containing watch paths. QunThink's checked-in patterns are `./index.html` and
`./src/**/*.{js,ts,jsx,tsx}`, with a single brace level. Vite's PostCSS integration uses those repository
sources; the Tailwind CLI watcher is a separate development path. No application source imports these
build packages or invokes the build pipeline from an upload/chat request. Uploaded files are handled
by the backend upload directory rather than these frontend content globs.

This narrows the observed exposure to build/development inputs. It is not proof that braces is safe:
the recursive expansion remains vulnerable, and a resource-bounded local probe of a deeply nested
pattern can raise a catchable RangeError. Treat repository/configuration changes and build workspace
paths as trusted inputs, review external contributions before running them, and revisit the upstream
advisory when a maintained compatible fix becomes available. Do not expose the development server or
an arbitrary-pattern build service to untrusted callers.
