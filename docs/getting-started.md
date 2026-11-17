# Getting started

A TypeScript library and local controller for applications that run coding agents. Create native Claude Code and Codex sessions, send work, handle permissions and follow results through one API.

Use it to build an agent dashboard, editor integration or automated development workflow. jg-agent-hq owns local session control. Your application owns its interface, authentication and off-machine backups. Native CLIs supply the coding harnesses, tools, skills and sign-in.

Requires Node.js 24.15.0 or later on Linux or macOS. State safety relies on POSIX ownership and private directories. Windows is outside the supported host contract.

## Installation

Install the package locally:

```sh
npm install jg-agent-hq
npx jg-agent-hq serve --state-root .runtime --workspace-root .
```

Install Claude Code and/or Codex separately and sign in through their native CLIs. Run the controller in your trusted workspace. The CLI examples below assume the installed executable is on PATH; prefix them with `npx` for a local npm installation.

This public package provides a local controller and browser-safe contracts. Applications own their UI, authentication and deployment. It does not include a hosted app or a user interface.

## Local controller

Install the providers you want and sign in through their native CLIs, then start `jg-agent-hq serve --state-root .runtime --workspace-root /path/to/workspace`. Run `jg-agent-hq status --state-root .runtime` in a client. `threads` lists the sessions of several folders and both providers by last activity, with the sessions the runtime created before their first turn, in pages whose cursor resumes each source where it stopped; see [session discovery](../api/README.md#session-discovery). `thread`, `items` and `usage` read native information, and each item carries its time as `createdAt` (Unix milliseconds, null when unavailable); Codex uses recorded item lifecycle times for saved and live items, without substituting a shared turn time; `thread` answers from the runtime's records, its history unavailable, when its provider can't read it. `item-detail` reads what a developer inspects in one item: its command and output, tool call, file diffs and images, and `item-image` returns one of its images. `stop` waits for confirmed runtime shutdown.

The [public API](../api/README.md#controller-overview) owns Node exports, native control, receipts and recovery boundaries.

## Lock ownership

Use a trusted private state root and retain its ownership boundaries. The [runtime ownership guide](architecture.md#lock-ownership) owns lock lifetime and recovery; [machine locks](../api/README.md#machine-locks) describes the independent machine-wide list.

## Source examples

Follow the [complete session walkthrough](https://jg-agent-hq.jesusgraterol.dev/examples/), with copyable source and its result.

`examples/control-session.ts` creates a native session and reads its actual delivery, output, permission and usage observations.

These complete TypeScript examples use the public client and contracts. Start the local controller and sign in to the native CLIs first. The host supplies actual user decisions and keeps native permission handling separate. Retain request identities before submission; after an interrupted client call, inspect those receipts instead of rerunning a whole example. Examples are development sources, not package exports or automatic website actions.

`examples/shared-storage.ts` uses a trusted Node runtime to save a singleton application preference under the app\_ prefix through `openHostDatabase`, capture shared SQLite storage with `createSnapshot`, and verify the value after offline restore. It closes its own SQL connections and preserves the host's user_version. Select absent output directories and pause every other writer first. The application write commits before capture; a later backup failure does not roll it back. The recovered state still requires explicit allowed roots before execution.

The [qualification matrix](../api/README.md#qualification) records native journeys, host coverage and remaining interface limits.

## Development

[Development](development.md) owns contributor setup, the module map and command selection.

## Testing

[Testing policy](testing.md) owns essential/full suites, focused verification and release-check limits.

## Project blueprint

The [repository index](../README.md#project-blueprint) routes implementation and contributor tasks to their owners.
