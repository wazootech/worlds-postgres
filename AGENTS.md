# AI agent coding guidelines

- This repo is the standalone `@worlds/postgres` package. Keep imports local to
  this repo and use `@/postgres/...` for in-repo absolute imports.
- Public exports should live in `deno.json`; keep `src/mod.ts` as the root
  barrel.
- Follow the existing JSDoc and naming style in the source files.
- Tests use `node:test` and `node:assert/strict` (plus the helpers in
  `src/postgres/testing/assertions.ts`) so they run on Deno and Bun. Do not add
  `Deno.*` APIs or `@std/*` imports to tests or source.
- Run `deno fmt` before committing, then `deno task ci` (Deno) and
  `bun run test` (Bun) before merging.
