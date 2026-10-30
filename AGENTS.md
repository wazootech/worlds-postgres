# AI agent coding guidelines

- This repo is the standalone `@worlds/postgres` package. Keep imports local to
  this repo and use `@/postgres/...` for in-repo absolute imports.
- Public exports should live in `deno.json`; keep `src/mod.ts` as the root
  barrel.
- Follow the existing JSDoc and naming style in the source files.
- Run `deno fmt` before committing, then `deno task ci` before merging.

## Code health

Family-wide rules live in the
[wazootech workspace constitution](https://github.com/wazootech/workspace/blob/main/AGENTS.md#code-health-standards);
this repo's specifics:

- Before pushing, run `deno task ci` (fmt check, lint, type check, tests).
- Deno type checking is strict by default; do not weaken it.
- The single `deno-lint-ignore no-explicit-any` in
  `src/postgres/rdfjs-store/pg-event-emitter.ts` covers a commented EventEmitter
  listener type; keep its explanatory comment and add no new `any` without one.
- Actions in `.github/workflows/` are pinned to full commit SHAs, CI pins Deno
  to `v2.9.8`, and installs are frozen (`deno ci`).
- `secret-scan.yml` runs gitleaks on every PR and push to `main`; report
  findings, never suppress them.
- `code-health.yml` enforces the file-length limit (120 lines of code per source
  file, 300 per test; blank, comment, and import lines excluded) and fails the
  build on any violation. Its explicit allowlist is empty and may only shrink.
  TODO/FIXME without an issue link stays warn-only.
- `.github/CODEOWNERS` and `renovate.json` are present; Renovate only acts where
  the org has the Renovate GitHub App installed.
