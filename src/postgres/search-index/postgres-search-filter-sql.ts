import type { QuadFilter } from "@worlds/sdk/quad-store";

/**
 * escapeLike escapes LIKE wildcards so a literal prefix match stays exact
 * (chunk row ids embed content-hash quad ids).
 */
export function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

/**
 * filterSql translates a QuadFilter (include = AND, exclude = OR-reject)
 * into SQL over the payload's term records. Graph criteria treat the
 * default graph as the empty value, exactly like filterQuads.
 */
export function filterSql(
  bind: (value: string) => string,
  include?: QuadFilter["include"],
  exclude?: QuadFilter["exclude"],
): { where: string[] } {
  const where: string[] = [];
  const criteriaSql = (
    criteria: NonNullable<QuadFilter["include"]> | undefined,
  ): string[] => {
    const parts: string[] = [];
    const inJsonArray = (param: string): string =>
      `IN (SELECT jsonb_array_elements_text(${param}::jsonb))`;
    if (criteria?.subjects?.length) {
      parts.push(
        `payload->'s'->>'v' ${
          inJsonArray(bind(JSON.stringify(criteria.subjects)))
        }`,
      );
    }
    if (criteria?.predicates?.length) {
      parts.push(
        `payload->'p'->>'v' ${
          inJsonArray(bind(JSON.stringify(criteria.predicates)))
        }`,
      );
    }
    if (criteria?.graphs?.length) {
      const arrayParam = bind(JSON.stringify(criteria.graphs));
      parts.push(
        `((payload->'g'->>'t' = 'D' AND '' ${inJsonArray(arrayParam)}) ` +
          `OR (payload->'g'->>'t' = 'N' AND payload->'g'->>'v' ${
            inJsonArray(arrayParam)
          }))`,
      );
    }
    return parts;
  };
  const includeParts = criteriaSql(include);
  if (includeParts.length > 0) {
    where.push(`(${includeParts.join(" AND ")})`);
  }
  const excludeParts = criteriaSql(exclude);
  if (excludeParts.length > 0) {
    where.push(`NOT (${excludeParts.join(" OR ")})`);
  }
  return { where };
}

/**
 * chunkFilterSql translates a QuadFilter into column scoping over the
 * chunks table (subject/predicate/graph IN / NOT IN). The graph column
 * stores the quad's graph value directly — the empty string for the
 * default graph, matching filterQuads.
 */
export function chunkFilterSql(
  bind: (value: string) => string,
  include?: QuadFilter["include"],
  exclude?: QuadFilter["exclude"],
): { where: string[] } {
  const where: string[] = [];
  const criteriaSql = (
    criteria: NonNullable<QuadFilter["include"]> | undefined,
    negate: boolean,
  ): string[] => {
    const parts: string[] = [];
    const inList = (values: string[], column: string): string =>
      `${column} ${negate ? "NOT " : ""}IN (${values.map(bind).join(", ")})`;
    if (criteria?.subjects?.length) {
      parts.push(inList(criteria.subjects, "subject"));
    }
    if (criteria?.predicates?.length) {
      parts.push(inList(criteria.predicates, "predicate"));
    }
    if (criteria?.graphs?.length) {
      parts.push(inList(criteria.graphs, "graph"));
    }
    return parts;
  };
  const includeParts = criteriaSql(include, false);
  if (includeParts.length > 0) {
    where.push(`(${includeParts.join(" AND ")})`);
  }
  const excludeParts = criteriaSql(exclude, true);
  if (excludeParts.length > 0) {
    where.push(`(${excludeParts.join(" OR ")})`);
  }
  return { where };
}
