# File catalog CLI

Implement a local Node.js CLI with three reviewable capabilities. Use Node built-ins only.

## Current code and completed work

README.md describes the project. source.mjs implements loadManifest and createCatalogTable.
loadManifest already reads UTF-8 JSON, rejects anything except an object containing a nonempty files array, requires every file entry to be a nonempty string, and returns sorted unique paths. verify-manifest.mjs exercises valid, malformed, empty and duplicate input with Node assertions. This behavior is complete and must remain unchanged.
createCatalogTable already creates a SQLite catalog_entry table with path as its primary key and a size integer. Catalog indexing is in progress: insertion, idempotent refresh and bounded keyset search remain.

## Required result

1. Keep the completed manifest validation behavior. source.mjs and verify-manifest.mjs own it. Run node verify-manifest.mjs to verify it.
2. Finish SQLite indexing in catalog.mjs and verify-catalog.mjs. Reuse createCatalogTable. Index the manifest paths and actual file sizes atomically. Refresh idempotently. Search sorted paths with a validated exclusive after-path cursor and limit 32, maximum128. Tests use a real temporary SQLite database, refresh twice and exercise page boundaries.
3. Add report.mjs and verify-report.mjs. Export a JSON report containing sorted catalog entries and a SHA-256 checksum of the canonical entries JSON. This checksum is an added requirement. Write the report through a temporary sibling and atomic rename, preserve an existing destination on failure and clean owned scratch files. Tests verify the checksum, stable ordering and failure behavior.
   Update README.md alongside the affected capability.

## Boundaries

No external services, dependencies, user-interface work, new configuration or compatibility behavior. Do not implement during breakdown.

## Strategic order and review checkpoints

Review completed manifest validation first, finish and test SQLite indexing second, then implement and verify the atomic checksummed report. Every slice owns its implementation, focused tests and README synchronization. Retain completed and in-progress status from repository evidence.

## Approval required

Approve this exact three-capability implementation scope.
