# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/achzuldaf/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/achzuldaf/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process, standard library only. It hosts real git
repositories — smart-HTTP clone, fetch (protocol v0 and v2, with shallow and deepen) and push with
fast-forward enforcement and report-status — and serves the GitHub REST v3 surface (repositories,
branches, git refs, commits, contents, labels, issues, comments, pull requests with file diffs and
squash/merge), the GraphQL v4 documents `gh` and `github-mcp-server` send (viewer, repository,
connections with cursor pagination, introspection probes, `node(id:)`, and the create/close/merge/
comment mutations), and an MCP endpoint (2026-07-28 `server/discover` plus the legacy initialize
handshake) whose six tools act on the same store as REST. One in-memory store backs every surface,
so an object created over any of them reads back identically over the others; pushed git objects are
stored and re-served byte-exact. There is deliberately no web UI and no `git` binary: the forge is a
pure protocol implementation (`node:crypto` SHA-1 object ids, `node:zlib` packfiles, OFS/REF delta
resolution including thin packs).

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the harness lifecycle: it needs `MAKEFUN_ENV_URL` (the env to register the bound port
with) and `MAKEFUN_SHOP_TOKEN` (the bearer token every API call must carry). For local poking
without the harness, `tools/dev.ts` serves the same app on a fixed port, and `tools/stub-env.ts`
stands in for the env so the kit's conformance runner can grade a local build.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

## License

MIT — see `LICENSE`.
