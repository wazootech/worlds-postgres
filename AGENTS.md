# AI agent coding guidelines

- This repo is the standalone `@worlds/postgres` package. Keep imports local to
  this repo and use `@/postgres/...` for in-repo absolute imports.
- Public exports should live in `deno.json`; keep `src/mod.ts` as the root
  barrel.
- Follow the existing JSDoc and naming style in the source files.
- Run `deno fmt` before committing, then `deno task ci` before merging.
