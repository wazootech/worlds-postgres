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
