# AI agent coding guidelines

- This repo is the standalone `@worlds/postgres` package. Keep imports local to
  this repo and use `@/postgres/...` for in-repo absolute imports.
- Public exports live in `jsr.json` and are mirrored in `package.json`
  (`bun run check:manifests` fails on drift); keep `src/mod.ts` as the root
  barrel.
- Follow the existing JSDoc and naming style in the source files.
- Tooling is Bun: `bun install`, then `bun run ci` (format, lint, type check,
  manifest check, tests). Format with `bun fmt --no-script`. Publishing goes
  through `bunx jsr publish`.
- Tests use `node:test` and `node:assert/strict` (plus the helpers in
  `src/postgres/testing/assertions.ts`), so keep tests and source free of
  `Deno.*` APIs and `@std/*` imports; the package still serves Deno consumers.
