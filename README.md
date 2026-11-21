<p align="center">
  <a href="https://docs.wazoo.dev">
    <img src="https://wazoo.dev/assets/wazoo.svg" alt="Wazoo Worlds" width="120" />
  </a>
  <br /><br />
  <em>PostgreSQL quad store and search index for Worlds.</em>
  <br /><br />
  <a href="https://github.com/wazootech/worlds-postgres"><img src="https://img.shields.io/badge/GitHub-black?logo=github" alt="GitHub" /></a>
  <a href="https://deepwiki.com/wazootech/worlds-postgres"><img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki" /></a>
</p>

Standalone PostgreSQL quad store and search index package extracted for the
[`@worlds`](https://jsr.io/@worlds) ecosystem.

## Install

### Package managers

```sh
# Deno (first-class JSR support)
deno add jsr:@worlds/postgres

# Bun / npm / pnpm / Yarn (via JSR npm compatibility layer)
npx jsr add @worlds/postgres
```

### CDN (browser / no build step)

[esm.sh](https://esm.sh) serves JSR packages as ES modules — no install, no
bundler needed.

```js
import { createPostgresWorldsSdk } from "https://esm.sh/jsr/@worlds/postgres@0.2.0";
```

With an import map:

```html
<script type="importmap">
{
  "imports": {
    "@worlds/postgres": "https://esm.sh/jsr/@worlds/postgres@0.2.0"
  }
}
</script>
<script type="module">
import { createPostgresWorldsSdk } from "@worlds/postgres";
</script>
```

Pin to an exact build for deterministic caching:

```js
import { createPostgresWorldsSdk } from "https://esm.sh/jsr/@worlds/postgres@0.2.0?pin=v1724100000";
```

## Usage

The SDK factory assembles the full facade (quad store + keyword search + SPARQL
engine) over a shared `postgres.Sql` surface:

```typescript
import postgres from "postgres";
import { createPostgresWorldsSdk } from "@worlds/postgres/sdk";

const sql = postgres("postgres://localhost/worlds");
const sdk = await createPostgresWorldsSdk({ sql });
```

Reference subpaths mirror the other Worlds backends:

```typescript
import { PostgresQuadStore } from "@worlds/postgres/quad-store";
import { PostgresSearchIndex } from "@worlds/postgres/search-index";
import { PostgresRdfjsStore } from "@worlds/postgres/rdfjs-store";
```

## Hybrid search

`PostgresSearchIndex.search` has two modes:

- **Keyword-only** (no embedding service): the reference's exact keyword
  semantics — case-insensitive substring over textual literals in the live quads
  table. This is the parity path.
- **Hybrid** (embedding service configured): Reciprocal Rank Fusion over the
  chunks table — a tsvector keyword branch (`to_tsvector`/`plainto_tsquery` in
  the configured `ftsLanguage`, default `"english"`) and a pgvector cosine
  branch, each ranked 1..topK and fused as `1/(60 + rank)` summed, consistent
  with `@worlds/libsql`. A query-time embedding failure degrades to the keyword
  branch; an empty query runs the vector branch alone.

```typescript
import { createPostgresWorldsSdk } from "@worlds/postgres/sdk";

const sdk = await createPostgresWorldsSdk({
  sql,
  embeddingService: myEmbeddingService,
  vectorDimensions: 1536,
  ftsLanguage: "english",
  textSplitter: new RecursiveCharacterTextSplitter({ chunkSize: 1000 }),
});
await sdk.import({ source }); // chunks are projected in the commit itself
await sdk.reindex(); // optional full rebuild (new splitter or embedding model)
const { results } = await sdk.search({ query: "hybrid query" });
```

Commits slice and `reindex()` slices long literal values into chunk rows via the
optional `textSplitter` (any `TextSplitterInterface`, e.g. LangChain's
`RecursiveCharacterTextSplitter`) — each piece is embedded and FTS-indexed
separately, consistent with `@worlds/libsql`. Without a splitter, one chunk row
per textual literal is written (the identity default).

### Commit path

Commits run the shared SQL commit core (`@worlds/sqlite/sql-core`, the same
`commitSqlPatch` the other SQL backends use) over a Postgres driver and dialect.
With an `embeddingService` set, a commit writes its quads, deletions,
replace-import wipe and chunk rows in **one SQL transaction**, so it lands whole
or not at all. Chunks and embeddings are computed before the transaction opens:
an embedding failure rejects the commit with nothing written (retry it).
`searchIndexOnImport` (default `"incremental"`) picks `"incremental"` (project
in every commit), `"deferred"` (skip projection during an import and rebuild
once after it) or `"disabled"` (never project at commit; use `reindex()`).
Without an `embeddingService` no chunk rows are kept and a commit writes quads
only.

`reindex()` is the full rebuild through the shared `rebuildSqlSearchIndex`. Each
page of quads is chunked and embedded first (each distinct text is embedded
once), then written in a single SQL transaction. An unscoped rebuild clears
every chunk row in its first page's transaction (also dropping rows of quads
that no longer exist), so a failure on a later page leaves the later pages
unindexed until it is run again. A scoped rebuild (`include`/`exclude`) replaces
only the rows of the quads in scope. The rebuild as a whole is not one
transaction.

## Parity

`deno task ci` runs a full-corpus parity suite (`runParitySuite` from
`@worlds/sdk/testing`) comparing `createPostgresWorldsSdk` against the portable
in-memory reference (`@worlds/sdk/memory`) over PGlite — search ordering is
compared set-wise, since SQL keyword-scan order is not a parity contract. The
shared commit conformance suite (`runCommitConformanceSuite`) runs against the
real commit path too, with all nine cases and the converged contract (atomic
commit, embedding failure throws, default `"incremental"`); see
`src/postgres/testing/commit-conformance.test.ts`.

## Development

```bash
deno task ci
```

Dry-run a JSR publish locally:

```bash
deno task publish:dry
```

## Publishing to JSR

Every push to `main` runs the [Publish workflow](.github/workflows/publish.yml),
which publishes only when `deno.json`'s `version` is not yet on JSR:

- **Release PR** (bumps `version`): merging it publishes the new version of
  `@worlds/postgres`.
- **Routine PR** (no bump): the Publish job skips green with a notice. That is
  expected, not a failure.

To release, bump `version` in `deno.json` (minor for additive public API, patch
for fixes) in the PR that should ship. If the package ever imports a pinned
`jsr:@worlds/postgres@<version>` of itself, commit that entry to `deno.lock`;
otherwise a cold CI run rewrites the lockfile and `deno publish` aborts on the
dirty tree.
