import { assertEquals, assertStringIncludes } from "@std/assert";
import { buildPostgresSchemaSql } from "./postgres-schema-builder.ts";

Deno.test("buildPostgresSchemaSql generates valid SQL statements", () => {
  const sql = buildPostgresSchemaSql();

  assertStringIncludes(sql, "CREATE EXTENSION IF NOT EXISTS vector;");
  assertStringIncludes(sql, "CREATE TABLE IF NOT EXISTS worlds_quads");
  assertStringIncludes(sql, "CREATE TABLE IF NOT EXISTS worlds_search_chunks");
  assertStringIncludes(sql, "USING hnsw (embedding vector_cosine_ops)");
  assertStringIncludes(sql, "USING gin (tsv)");
});

Deno.test("buildPostgresSchemaSql respects custom table names and dimensions", () => {
  const sql = buildPostgresSchemaSql({
    quadsTableName: "custom_quads",
    searchChunksTableName: "custom_chunks",
    vectorDimension: 768,
  });

  assertStringIncludes(sql, "CREATE TABLE IF NOT EXISTS custom_quads");
  assertStringIncludes(sql, "CREATE TABLE IF NOT EXISTS custom_chunks");
  assertStringIncludes(sql, "vector(768)");
});
