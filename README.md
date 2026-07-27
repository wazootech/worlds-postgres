# Worlds Postgres

Standalone PostgreSQL quad store and search index package extracted for the [`@worlds`](https://jsr.io/@worlds) ecosystem.

## Install

```bash
deno add jsr:@worlds/postgres
```

## Usage

```typescript
import postgres from "postgres";
import { PostgresQuadStore } from "@worlds/postgres/quad-store";
import { PostgresSearchIndex } from "@worlds/postgres/search-index";
import { PostgresRdfjsStore } from "@worlds/postgres/rdfjs-store";
```

## Development

```bash
deno task ci
```

Dry-run a JSR publish locally:

```bash
deno task publish:dry
```

## Publishing to JSR

Releases publish automatically when changes merge to `main`.
