import type { QuadFilter } from "@worlds/sdk/quad-store";

/** Criteria is one side (include or exclude) of a QuadFilter. */
type Criteria = NonNullable<QuadFilter["include"]>;

/** criteriaSql renders the AND-ed predicates of one filter side over the payload's term records. */
function criteriaSql(
  bind: (value: string) => string,
  criteria: Criteria | undefined,
): string[] {
  const parts: string[] = [];
  const inJsonArray = (param: string): string =>
    `IN (SELECT jsonb_array_elements_text(${param}::jsonb))`;
  if (criteria?.subjects?.length) {
    parts.push(
      `payload->'s'->>'v' ${inJsonArray(
        bind(JSON.stringify(criteria.subjects)),
      )}`,
    );
  }
  if (criteria?.predicates?.length) {
    parts.push(
      `payload->'p'->>'v' ${inJsonArray(
        bind(JSON.stringify(criteria.predicates)),
      )}`,
    );
  }
  if (criteria?.graphs?.length) {
    const arrayParam = bind(JSON.stringify(criteria.graphs));
    parts.push(
      `((payload->'g'->>'t' = 'D' AND '' ${inJsonArray(arrayParam)}) ` +
        `OR (payload->'g'->>'t' = 'N' AND payload->'g'->>'v' ${inJsonArray(
          arrayParam,
        )}))`,
    );
  }
  return parts;
}

/**
 * quadFilterSql translates a QuadFilter (include = AND, exclude = OR-reject)
 * into WHERE predicates over the quads table's payload term records. Graph
 * criteria treat the default graph as the empty value, exactly like
 * filterQuads. `bind` registers a parameter and returns its `$n` placeholder.
 */
export function quadFilterSql(
  bind: (value: string) => string,
  include?: QuadFilter["include"],
  exclude?: QuadFilter["exclude"],
): string[] {
  const where: string[] = [];
  const includeParts = criteriaSql(bind, include);
  if (includeParts.length > 0) {
    where.push(`(${includeParts.join(" AND ")})`);
  }
  const excludeParts = criteriaSql(bind, exclude);
  if (excludeParts.length > 0) {
    where.push(`NOT (${excludeParts.join(" OR ")})`);
  }
  return where;
}
