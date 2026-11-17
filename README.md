# jg-agent-hq

A TypeScript library and local controller for applications that run native Claude Code and Codex sessions. It owns local session control, prompts, results and recoverable storage through one API. Your application owns its interface, authentication and off-machine backups; the native CLIs supply their harnesses, tools, skills and sign-in.

Requires Node.js 24.15.0 or later on Linux or macOS. State safety relies on POSIX ownership and private directories; Windows is outside the supported host contract.

## Installation

```sh
npm install jg-agent-hq
npx jg-agent-hq serve --state-root .runtime --workspace-root .
```

Install and sign in through the native providers separately. Follow [docs/getting-started.md](https://github.com/jesusgraterol/jg-agent-hq/blob/main/docs/getting-started.md) for usage and the complete source walkthrough.

## Project blueprint

| Need                                  | Read                                                                                                      | What it owns                                                                                        |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Start a controller or use the package | [docs/getting-started.md](https://github.com/jesusgraterol/jg-agent-hq/blob/main/docs/getting-started.md) | Installation, local control and source examples; canonical source for the website's /docs/ page.    |
| Change a public integration           | [api/README.md](api/README.md)                                                                            | Node/browser contracts, commands, files, native control and complete results.                       |
| Locate code or prepare development    | [docs/development.md](docs/development.md)                                                                | Contributor setup, command entry points and detailed module map.                                    |
| Understand runtime ownership          | [docs/architecture.md](docs/architecture.md)                                                              | Provider/storage boundaries, lifecycle and lock ownership.                                          |
| Capture, restore or downgrade safely  | [docs/recovery.md](docs/recovery.md)                                                                      | Snapshot coverage, native reconciliation and host durability responsibilities.                      |
| Select verification                   | [docs/testing.md](docs/testing.md)                                                                        | Built-public-export tests, essential/full selections, focused consumers and release identity rules. |
| Change the public website             | [website/README.md](website/README.md), [docs/website.md](docs/website.md)                                | Workspace checks, safe content sources, asset ownership and delivery boundaries.                    |
| Resolve intentional failures          | [errors/README.md](errors/README.md)                                                                      | Stable codes/messages and public classifications.                                                   |
| Deliver source or publish a release   | [docs/delivery.md](docs/delivery.md)                                                                      | Ordered development/main/npm stops, operators and verified release handling.                        |

## Repository map

| Entry                                    | Responsibility                                                                                      |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [src/](src/)                             | Public package boundary and local runtime, provider, session, action, storage and snapshot modules. |
| [examples/](examples/)                   | Complete client/session and trusted host-storage helpers.                                           |
| [api/](api/), [errors/](errors/)         | Public integration contracts and stable failures.                                                   |
| [scripts/](scripts/), [vitest/](vitest/) | Package/release tooling, disposable provider fixtures and category selection.                       |
| [website/](website/)                     | Private Astro workspace for the public package site.                                                |
| [docs/](docs/)                           | Durable getting-started, architecture, development, testing and delivery guides.                    |
