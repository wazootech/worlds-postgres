import test from "node:test";
import assert from "node:assert/strict";
import { assertStringIncludes, thrown } from "@/postgres/testing/assertions.ts";
import {
  buildPostgresSchemaSql,
  quoteFtsLanguage,
} from "./postgres-schema-builder.ts";

test("buildPostgresSchemaSql generates valid SQL statements", () => {
  const sql = buildPostgresSchemaSql();

  assertStringIncludes(sql, "CREATE EXTENSION IF NOT EXISTS vector;");
  assertStringIncludes(sql, "CREATE TABLE IF NOT EXISTS worlds_quads");
  assertStringIncludes(sql, "CREATE TABLE IF NOT EXISTS worlds_search_chunks");
  assertStringIncludes(sql, "USING hnsw (embedding vector_cosine_ops)");
  assertStringIncludes(sql, "USING gin (tsv)");
  assertStringIncludes(sql, "to_tsvector('english', text)");
});

test("buildPostgresSchemaSql respects custom table names, dimensions, and ftsLanguage", () => {
  const sql = buildPostgresSchemaSql({
    quadsTableName: "custom_quads",
    searchChunksTableName: "custom_chunks",
    vectorDimension: 768,
    ftsLanguage: "simple",
  });

  assertStringIncludes(sql, "CREATE TABLE IF NOT EXISTS custom_quads");
  assertStringIncludes(sql, "CREATE TABLE IF NOT EXISTS custom_chunks");
  assertStringIncludes(sql, "vector(768)");
  assertStringIncludes(sql, "to_tsvector('simple', text)");
});

test("quoteFtsLanguage validates regconfig names", () => {
  assert.deepStrictEqual(quoteFtsLanguage("english"), "'english'");
  assert.deepStrictEqual(
    quoteFtsLanguage("pg_catalog.simple"),
    "'pg_catalog.simple'",
  );
  thrown(() => quoteFtsLanguage("eng; DROP TABLE x"), Error);
  thrown(() => quoteFtsLanguage(""), Error);
});
