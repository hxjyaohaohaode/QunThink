# Q1 frozen-product browser baseline

This suite is deliberately an outcome baseline, not an expected-failure test. The application is frozen at `5056661e681665b7c82c25460af3ea6bc9112f4e` (tree `11324c41148214008c54a29195480a440673cd49`). A test-only commit supplies the runner; every run records its actual tested commit/tree, GitHub PR head/run, protected application subtrees, browser, viewport and timezone. Application/brand hashes, working-tree differences and untracked protected-path files are checked before and after each scenario.

## Operation and boundaries

Execution is permitted only in the authorized GitHub Actions CI run. The config, spec and backend entry point reject local runtime before browser/listener creation. Local `--list`, strict TypeScript checks and pure Node protocol tests are allowed. Do not set CI environment variables locally to bypass this restriction.

The dedicated launcher creates isolated account/data/encryption storage, uses session authentication and `NODE_ENV=development`, disables unrelated health probes/Goal scheduler/PostgreSQL, pins dotenv to an empty file, and clears inherited provider and SMS configuration. Development mode preserves the real chat scheduler that the existing `NODE_ENV=test` launcher suppresses. Registration uses the existing dev-only synthetic fixture, followed by actual visible phone/password login; this is not SMS or production onboarding evidence.

A deterministic HTTP fixture listens only on exact `http://127.0.0.1:3203`, with no credentials and no redirects. The user configures that fixture using the rendered model center, then creates a conversation, sends both source notes, and uses the real message-to-task action. Business objects are never created or changed through test API shortcuts, store injection, or fabricated UI. Read-only APIs corroborate actual UI effects. Fixture-control POSTs only release held fixture HTTP responses.

The fixture invitation body is predetermined. Its corrected date is not evidence of model reasoning. Tests separately inspect the actual provider body for both complete notes/purpose and the persisted run's source IDs/revisions. A whole-conversation source selection is valid scope; the evidence records every included message, including actual AI responses. Internal source IDs need not be transmitted to the model.

## Evidence and interpretation

- Both projects retain all traces and videos, plus natural (animation-unmodified) viewport/full-page screenshots before/after meaningful states
- The outcome ledger and actual invitation body are attached to each test result; neither source summaries nor another empty entry substitute for that body
- The product scenario inventories actual rendered output controls. Missing editing and inability to continue the same draft after a source correction produce a nonzero **product-gap** result after independent partial stages finish
- The unedited run's copy/accept/source-change/reopen exploration is explicitly partial. It cannot pass manual-edit preservation or exact edited-version acceptance
- The separate fault scenario drops an actual committed task-save ACK, reloads and finds the same persisted task/intent without a second save; it then stops a Task after actual fixture HTTP arrival, releases the late response attempt, reloads the same unknown run and dismisses retry approval without another provider call
- A disconnected socket means a late response *attempt*, not proof that the browser received a late ACK. Committed-save recovery does not cover pre-admission or unavailable-authority recovery
- Unexpected execution/harness errors remain separately recorded and fail; no `test.fail`, soft pass, caught-and-green assertion, or fabricated missing-control timeout hides them
- Clipboard readback is performed only if permission was already granted. No new browser permissions are requested; a copy-button acknowledgment alone is not readback proof

Actual browser evidence is produced by CI, not by local static checks. CI-operated traces remain scripted browser evidence, not a manual usability review. A passing partial fault case does not complete Q1, the other product scenarios, real provider semantics, production persistence, or all-component acceptance.


## Lossless CI evidence downloads

The original combined `qunthink-browser-evidence-<project>` artifact is still uploaded. CI additionally archives **all** files in `frontend/playwright-report/` and `frontend/test-results/` using lossless tar/gzip, including hidden files, full-size screenshots, videos and traces. It emits a manifest and up to 16 separately uploaded parts with a maximum **20 MiB raw payload per artifact**, leaving room for GitHub's ZIP wrapper below a 32 MiB download limit. Each upload contains exactly one part; downloading an individual part never downloads the combined archive.

The `qunthink-browser-evidence-parts-<project>-manifest` artifact contains the archive and per-part SHA-256 checksums, exact byte counts, ordered filenames, source run/checkout/project and included/missing evidence roots. Extract the manifest and every `...-part-001`, `...-part-002`, etc. ZIP into the same directory, then run:

```sh
node scripts/pack-ci-evidence.mjs restore /path/to/extracted-parts /path/to/new-evidence.tar.gz
tar -xzf /path/to/new-evidence.tar.gz -C /path/to/empty-evidence-directory
```

Restoration validates every part and the full archive and refuses to overwrite an existing output. Missing, corrupt, truncated or reordered parts fail. CI verifies its own parts before publishing the manifest. Exceeding 16 parts is an explicit packaging failure; nothing is truncated or recompressed with loss, and the independently uploaded full artifact remains available. Expand both the script limit and fixed workflow upload slots together if ever needed. Pure local packaging tests are `node --test scripts/pack-ci-evidence.test.mjs`; they use only synthetic temporary files and never start a browser, listener, provider or application.

The temporary recovery job completed in run `37229320120` and was removed after both original failed-run ZIPs were retrieved and reconstructed with exact original byte counts and SHA-256 verification. It does not run again on future PR updates. The original failed run `37228163396` remains failed; its preserved evidence does not become a new test success. Recovery manifests and separate parts remain in run `37229320120` as `qunthink-original-q1-evidence-<project>-manifest` / `...-part-001`, etc. Restore with a new `.zip` output:

- Desktop original artifact `11312347977`: 53,769,687 bytes, SHA-256 `d0a837b5034318a74f56de07baa17d13a73cfdba28cfddaeac24552b18da104c`
- Mobile original artifact `11313221243`: 39,518,533 bytes, SHA-256 `19602f41df35e08fe4177406689ab5bd38271dad7d5fd05815ffa6884ddf6707`

Normal chat scheduling observation uses at most four reads of the isolated fixture endpoint at one-second intervals, followed by one real message API read per note. No reply count is imposed, and real application rate limits stay enabled. Evidence records user-entered text, actual POST receipt content and actual provider body separately. Task assertions require complete stored source contents to reach the provider, without silently decoding HTML entities or claiming byte equality with the original user input. Source-link usability and model interpretation still require their own evidence.
