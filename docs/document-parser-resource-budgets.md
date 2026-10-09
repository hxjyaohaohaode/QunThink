# ZIP document parsing resource budgets

DOCX, XLSX, PPTX, EPUB and OpenDocument (ODT/ODS/ODP) now share a fail-closed parsing boundary. Existing text extraction and legacy-format behavior are retained for supported documents within the limits. No UI, logo, API route, model call, or database schema changes are involved.

## Limits

- 10 MiB compressed input, bounded during the read as well as by file metadata
- 512 ZIP entries
- 4 MiB actual uncompressed bytes per entry and 8 MiB aggregate
- 1 MiB UTF-8 text output, checked in the worker and on the parent's streaming pipe
- 5 seconds per worker, followed by forced process termination
- 128 MiB V8 old-space per worker (this is a heap limit, not an OS RSS limit)
- Two workers per application process across all these formats; additional work fails immediately rather than entering an unbounded queue

These fixed budgets keep text extraction suitable for conversational uploads. Large otherwise-valid documents fail explicitly; they are not silently truncated into a successful result. Split large documents before importing. Existing XLSX row/sheet/column and EPUB chapter display rules still apply within these budgets.

## Validation and isolation

The ZIP central and local records must agree. The parser rejects encryption, split/ZIP64 archives, unsupported compression, traversal names, ambiguous duplicate names, invalid offsets, overlapping/hidden entries, mismatched lengths or CRC, and trailing payloads. Stored and deflated entries, optional signed data descriptors, and reordered central directories are supported. Each actual inflate is bounded before allocating its result. Successfully checked bytes are rebuilt into a canonical archive before the format library can inspect them, avoiding divergent interpretations of attacker-controlled ZIP structures.

The parent copies only a bounded, regular-file input into a private temporary directory. The child receives that snapshot, format and basename, not the original path or application environment. It has no shell invocation and no inherited provider/DB credentials. Standard input and stderr are discarded; result stdout is byte-counted before buffering. Abort, timeout, worker errors and exits reclaim the process, snapshot and shared concurrency slot before settling the request. The internal parser accepts an AbortSignal; existing callers remain compatible.

ZIP archive listing uses the same input, entry-count, structural and process boundaries but deliberately does not decompress file content just to list names. Other archive types retain their metadata-only behavior. PDF, CSV, text/code and media parsing are outside this change; this is not a claim that every file format is now isolated.

## Regression tests

`backend/test/docx-resource-budget.test.js` covers normal/Unicode/empty/substantial DOCX, 12 MiB highly compressed expansion, forged metadata, aggregate and output budgets, malformed ZIP, stored entries/descriptors, concurrent admission, abort/timeout, worker crashes, oversized stdout, missing files/workers, secret isolation and temporary-file cleanup.

`backend/test/zip-document-resource-budget.test.js` covers normal extraction and compressed-expansion rejection for PPTX/EPUB/ODT/ODS/ODP/XLSX, output limits, and bounded no-inflate ZIP listing. Existing DOCX HTTP security and compatibility tests are retained unchanged.
