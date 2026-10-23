# Runtime ownership

## Providers

The runtime registers built-in and trusted Node-supplied provider factories at construction. It creates each adapter only when that provider is selected. Status and database-backed reads do not require a native CLI. Provider IDs flow through contracts, cursors and persistence; core actions, sessions and skills route through the registry. Native protocol parsing and invocation spelling stay with each adapter.

The registry binds callback identity, bounds operations, and validates consumed evidence. Optional capability failures remain separate from session control. Invalid control state or identity quarantines its source, and bounded per-provider lifecycle queues contain overload. A store failure affects shared persistence. Adapters own partial-startup cleanup and native process lifetime; runtime shutdown confirms cleanup before releasing ownership. Version labels are diagnostic metadata, never admission gates. Native input, settings, permissions and authentication remain with the installed harness.

## Storage

One SQLite worker owns HQ persistence. The complete definition, including provider history indexes, is src/store/schema.sql. Fresh initialization creates the schema and its singleton hq_schema hash in one transaction. Reopening validates that stamp through a read-only connection before opening a writer. This preserves rejected database bytes and their WAL instead of triggering SQLite's close-time checkpoint. Application-owned objects are outside this stamp. HQ does not modify user_version or convert persisted state between schema definitions; use a fresh development state root after an HQ schema change.

All HQ tables, indexes and named constraints use the hq\_ prefix. Hosts own their application prefixes and definitions. They may open a separate connection using the canonical path and connection settings supplied by the Node runtime. Prefixes express ownership within a trusted process; they do not protect against another process with access to the file. Direct application writes to HQ-owned tables are unsupported.

Maintenance closes new HQ admission, drains admitted operations and their nested calls, and waits for earlier worker commands. Native evidence needed to finish admitted work continues during the drain. It refuses active native execution and unresolved plan writes. During the host callback, new native event persistence waits for release through the existing bounded event lane; an already accepted scheduled stop also waits. The host callback owns its connection and must not call HQ, start native work or leave its transaction open. Callback failure releases admission without classifying the host's SQL effect as rolled back.

A host connection and an HQ API call cannot share one SQLite transaction. Cross-boundary work needs idempotency and reconciliation owned by the application. SQLite permits one writer at a time; unrelated host connections must cooperate with maintenance. The API reference owns connection settings, signatures and error contracts.
