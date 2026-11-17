# github-core-clone-01

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/sherrypubg128-blip/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/sherrypubg128-blip/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node 22 process, with no
dependencies and no git binary: git smart HTTP (upload-pack v2,
receive-pack v0) for clone, fetch and push; the REST v3 API under `/api/v3`
for repositories, branches, commits, contents, labels, issues and pull
requests (with squash merges); the GraphQL v4 API at `/api/graphql`; and a
Model Context Protocol endpoint at `/mcp`. Everything is served from a
deterministic in-memory store.

## Run it

```sh
node --experimental-strip-types main.ts
```

`MAKEFUN_ENV_URL` must name the harness env; the program binds an ephemeral
port, registers it, serves until the env reports done, then exits 0.

## Layout

- `main.ts` — the entry ↔ env lifecycle (bind, register, poll done, exit).
- `app.ts` — the HTTP server, dispatching to the four surfaces.
- `lib/store.ts` — the shared in-memory store: repos, git objects, issues,
  pull requests, labels, plus the tree/commit/merge git helpers.
- `lib/rest.ts` — the REST v3 surface (`handleRest`).
- `lib/git.ts` — git smart HTTP (`handleGit`).
- `lib/graphql.ts` — GraphQL v4 (`handleGraphql`).
- `lib/mcp.ts` — the MCP endpoint (`handleMcp`).
