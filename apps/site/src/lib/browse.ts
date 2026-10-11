// Browsing published tools: filters from the URL, the list query, faceted counts
// for the filter sidebar, and full-text search with highlighting. Every list page
// (/, /new, /search, /category/[name]) goes through browse().

import { type TagGroups, getSetting } from "@slop-bucket/core";
import { PAGE_SIZE, ROW_SELECT, type RawRow, type ToolRow, pageParam, toRow } from "./public.ts";

export const SORTS = { trending: "Trending", new: "Newest", stars: "Most stars", discussed: "Most discussed", best: "Best match" } as const;
export type Sort = keyof typeof SORTS;
export const STAR_STEPS = [10, 100, 1000, 10000] as const;
export const SEEN_DAYS = [7, 30, 90] as const;

export interface Filters {
  q: string;
  categories: string[];
  tags: string[];
  license: "" | "open" | "closed";
  /** Minimum stars (one of STAR_STEPS), or 0 for any. */
  stars: number;
  langs: string[];
  /** First seen within this many days (one of SEEN_DAYS), or 0 for any. */
  seen: number;
  sort: Sort;
  page: number;
}

const SLUG = /^[a-z0-9-]{1,60}$/;
const uniq = (values: string[], max: number) => [...new Set(values)].slice(0, max);

/** Filters from query parameters; anything malformed is ignored. */
export function parseFilters(params: URLSearchParams, defaultSort: Exclude<Sort, "best"> = "trending"): Filters {
  const q = (params.get("q") ?? "").trim().slice(0, 100);
  const stars = Number(params.get("stars"));
  const seen = Number(params.get("seen"));
  const license = params.get("license");
  const sort = params.get("sort");
  const hasQuery = searchWords(q).length > 0;
  return {
    q,
    categories: uniq(params.getAll("category").filter((c) => SLUG.test(c)), 20),
    tags: uniq(params.getAll("tag").filter((t) => SLUG.test(t)), 20),
    license: license === "open" || license === "closed" ? license : "",
    stars: (STAR_STEPS as readonly number[]).includes(stars) ? stars : 0,
    langs: uniq(params.getAll("lang").map((l) => l.trim()).filter((l) => l.length > 0 && l.length <= 40), 10),
    seen: (SEEN_DAYS as readonly number[]).includes(seen) ? seen : 0,
    sort: sort && sort in SORTS && (sort !== "best" || hasQuery) ? (sort as Sort) : hasQuery ? "best" : defaultSort,
    page: pageParam(params.get("page")),
  };
}

/** The filters as query parameters, leaving out defaults (`defaultSort` is the page's own). */
export function filterParams(f: Filters, defaultSort: Sort): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  for (const c of f.categories) p.append("category", c);
  for (const t of f.tags) p.append("tag", t);
  if (f.license) p.set("license", f.license);
  if (f.stars) p.set("stars", String(f.stars));
  for (const l of f.langs) p.append("lang", l);
  if (f.seen) p.set("seen", String(f.seen));
  // With a query, best match is the default whatever the page's own default is.
  if (f.sort !== (searchWords(f.q).length ? "best" : defaultSort)) p.set("sort", f.sort);
  if (f.page > 1) p.set("page", String(f.page));
  return p;
}

/** Words for an FTS5 prefix query: letters and digits only, so user input can't inject FTS syntax. */
export function searchWords(q: string): string[] {
  return (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 8);
}
const ftsMatch = (q: string) =>
  searchWords(q)
    .map((w) => `"${w}"*`)
    .join(" ");

/** Facets the sidebar counts; a facet's counts ignore its own filter. */
type Facet = "category" | "license" | "stars" | "lang" | "seen" | `tag:${string}`;

// Latest repo snapshot per tool (stars and language).
const LATEST = `latest AS (SELECT r.tool_id, r.stars, r.language FROM repo_snapshots r
  WHERE r.date = (SELECT max(r2.date) FROM repo_snapshots r2 WHERE r2.tool_id = r.tool_id))`;

function where(f: Filters, groups: TagGroups, omit?: Facet): { sql: string; binds: unknown[] } {
  const clauses = ["t.status = 'published'"];
  const binds: unknown[] = [];
  const inList = (values: unknown[]) => {
    binds.push(...values);
    return values.map(() => "?").join(", ");
  };
  const match = ftsMatch(f.q);
  if (match) {
    clauses.push("t.id IN (SELECT rowid FROM tools_fts WHERE tools_fts MATCH ?)");
    binds.push(match);
  }
  if (omit !== "category" && f.categories.length) clauses.push(`coalesce(t.category, 'other') IN (${inList(f.categories)})`);
  // Tags: any of the chosen tags within a group, every group with a choice.
  for (const g of groups) {
    const chosen = f.tags.filter((t) => g.tags.some((x) => x.slug === t));
    if (chosen.length && omit !== `tag:${g.slug}`) clauses.push(`EXISTS (SELECT 1 FROM json_each(t.tags) j WHERE j.value IN (${inList(chosen)}))`);
  }
  if (omit !== "license" && f.license) clauses.push(f.license === "open" ? "t.is_open_source = 1" : "t.is_open_source = 0");
  if (omit !== "stars" && f.stars) {
    clauses.push("l.stars >= ?");
    binds.push(f.stars);
  }
  if (omit !== "lang" && f.langs.length) clauses.push(`l.language IN (${inList(f.langs)})`);
  if (omit !== "seen" && f.seen) {
    clauses.push("t.first_seen_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)");
    binds.push(`-${f.seen} days`);
  }
  return { sql: `WITH ${LATEST} SELECT {cols} FROM tools t LEFT JOIN latest l ON l.tool_id = t.id WHERE ${clauses.join(" AND ")}`, binds };
}

const ORDER: Record<Sort, string> = {
  trending: "t.trending_score DESC, t.id",
  new: "t.first_seen_at DESC, t.id DESC",
  stars: "coalesce(l.stars, -1) DESC, t.trending_score DESC, t.id",
  discussed: "posts DESC, t.trending_score DESC, t.id",
  // Name matches weigh most, then description, then tags.
  best: "bm25(tools_fts, 10.0, 3.0, 1.0), t.trending_score DESC, t.id",
};

// Highlight markers: control characters that can't occur in tool text, swapped
// for <mark> after HTML-escaping (see highlightHtml).
const MARK_OPEN = "\u0001";
const MARK_CLOSE = "\u0002";

export interface Facets {
  categories: Map<string, number>;
  tags: Map<string, number>;
  license: { open: number; closed: number };
  stars: Map<number, number>;
  langs: [string, number][];
  seen: Map<number, number>;
}

export interface BrowseRow extends ToolRow {
  /** Name and description with search matches marked, as safe HTML; only with a query. */
  nameHtml?: string;
  descriptionHtml?: string;
}

export interface BrowseResult {
  tools: BrowseRow[];
  total: number;
  facets: Facets;
}

export async function browse(db: D1Database, f: Filters, groups: TagGroups): Promise<BrowseResult> {
  const match = ftsMatch(f.q);
  const base = where(f, groups);
  const rowSelect = ROW_SELECT.replace(/^SELECT /, "").replace(/\s+FROM tools t$/, "");
  const highlight = match
    ? `, highlight(tools_fts, 0, '${MARK_OPEN}', '${MARK_CLOSE}') AS name_marked, highlight(tools_fts, 1, '${MARK_OPEN}', '${MARK_CLOSE}') AS description_marked`
    : "";
  let listSql = base.sql.replace("{cols}", rowSelect + highlight);
  const listBinds = [...base.binds];
  if (match) {
    // The join gives bm25() and highlight() their row; it repeats the MATCH.
    listSql = listSql.replace("LEFT JOIN latest l ON l.tool_id = t.id", "LEFT JOIN latest l ON l.tool_id = t.id JOIN tools_fts ON tools_fts.rowid = t.id AND tools_fts MATCH ?");
    listBinds.unshift(match);
  }
  listSql += ` ORDER BY ${ORDER[f.sort === "best" && !match ? "trending" : f.sort]} LIMIT ? OFFSET ?`;
  listBinds.push(PAGE_SIZE, (f.page - 1) * PAGE_SIZE);

  const facet = (omit: Facet, cols: string, tail = "") => {
    const w = where(f, groups, omit);
    return db.prepare(w.sql.replace("{cols}", cols) + tail).bind(...w.binds);
  };
  const tagFacets = groups.map((g) => {
    const w = where(f, groups, `tag:${g.slug}`);
    const slugs = g.tags.map((t) => t.slug);
    const sql = w.sql.replace("{cols}", "j.value AS k, count(*) AS n").replace("LEFT JOIN latest l ON l.tool_id = t.id", "LEFT JOIN latest l ON l.tool_id = t.id, json_each(t.tags) j");
    return db.prepare(`${sql} AND j.value IN (${slugs.map(() => "?").join(", ")}) GROUP BY j.value`).bind(...w.binds, ...slugs);
  });
  const starCols = STAR_STEPS.map((s) => `coalesce(sum(l.stars >= ${s}), 0) AS s${s}`).join(", ");
  const seenCols = SEEN_DAYS.map((d) => `coalesce(sum(t.first_seen_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${d} days')), 0) AS d${d}`).join(", ");

  const results = await db.batch<Record<string, unknown>>([
    db.prepare(listSql).bind(...listBinds),
    db.prepare(base.sql.replace("{cols}", "count(*) AS n")).bind(...base.binds),
    facet("category", "coalesce(t.category, 'other') AS k, count(*) AS n", " GROUP BY k"),
    facet("license", "coalesce(sum(t.is_open_source = 1), 0) AS open, coalesce(sum(t.is_open_source = 0), 0) AS closed"),
    facet("stars", starCols),
    facet("lang", "l.language AS k, count(*) AS n", " AND l.language IS NOT NULL GROUP BY l.language ORDER BY n DESC, k LIMIT 12"),
    facet("seen", seenCols),
    ...tagFacets,
  ]);
  const [list, count, cats, license, stars, langs, seen, ...tags] = results.map((r) => r.results);
  const pairs = (rows: Record<string, unknown>[]) => rows.map((r) => [r.k as string, r.n as number] as [string, number]);

  return {
    tools: (list as unknown as (RawRow & { name_marked?: string; description_marked?: string })[]).map((raw) => {
      const { name_marked, description_marked, ...rest } = raw;
      const row: BrowseRow = toRow(rest as RawRow);
      if (match) {
        row.nameHtml = highlightHtml(name_marked ?? row.name);
        if (row.description) row.descriptionHtml = highlightHtml(description_marked ?? row.description);
      }
      return row;
    }),
    total: (count![0]!.n as number) ?? 0,
    facets: {
      categories: new Map(pairs(cats!)),
      tags: new Map(tags.flatMap((rows) => pairs(rows))),
      license: { open: Number(license![0]!.open), closed: Number(license![0]!.closed) },
      stars: new Map(STAR_STEPS.map((s) => [s, Number(stars![0]![`s${s}`])])),
      langs: pairs(langs!),
      seen: new Map(SEEN_DAYS.map((d) => [d, Number(seen![0]![`d${d}`])])),
    },
  };
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** FTS5 highlight() output as safe HTML: text escaped, match markers turned into <mark>. */
export function highlightHtml(marked: string): string {
  return escapeHtml(marked)
    .replaceAll(MARK_OPEN, '<mark class="bg-lime-50 text-inherit shadow-[inset_0_-2px_0_var(--color-lime-400)] dark:bg-lime-400/15">')
    .replaceAll(MARK_CLOSE, "</mark>");
}

/** A link to `base` with these filters changed; any change goes back to page 1. */
export function browseHref(base: string, f: Filters, defaultSort: Sort, patch: Partial<Filters> = {}): string {
  const query = filterParams({ ...f, page: 1, ...patch }, defaultSort).toString();
  return query ? `${base}?${query}` : base;
}

export interface Chip {
  label: string;
  /** The same page without this filter. */
  href: string;
}

/** One removable chip per active filter (the query and sort aren't filters). */
export function activeChips(base: string, f: Filters, defaultSort: Sort, labels: { category: (slug: string) => string; tag: (slug: string) => string }): Chip[] {
  const href = (patch: Partial<Filters>) => browseHref(base, f, defaultSort, patch);
  return [
    ...f.categories.map((c) => ({ label: labels.category(c), href: href({ categories: f.categories.filter((x) => x !== c) }) })),
    ...f.tags.map((t) => ({ label: labels.tag(t), href: href({ tags: f.tags.filter((x) => x !== t) }) })),
    ...(f.license ? [{ label: f.license === "open" ? "Open source" : "Closed source", href: href({ license: "" }) }] : []),
    ...(f.stars ? [{ label: `${compactStep(f.stars)}+ stars`, href: href({ stars: 0 }) }] : []),
    ...f.langs.map((l) => ({ label: l, href: href({ langs: f.langs.filter((x) => x !== l) }) })),
    ...(f.seen ? [{ label: `First seen in the last ${f.seen} days`, href: href({ seen: 0 }) }] : []),
  ];
}

/** 10, 100, 1k, 10k */
export const compactStep = (n: number) => (n >= 1000 ? `${n / 1000}k` : String(n));

export interface BrowsePage {
  filters: Filters;
  result: BrowseResult;
  groups: TagGroups;
  categories: string[];
  /** Set when the page number is past the end: redirect there. */
  redirect?: string;
}

/** Everything a list page needs. `fixedCategory` pins the category (on /category/[name]). */
export async function loadBrowsePage(db: D1Database, url: URL, base: string, defaultSort: Exclude<Sort, "best">, fixedCategory?: string): Promise<BrowsePage> {
  const filters = parseFilters(url.searchParams, defaultSort);
  if (fixedCategory) filters.categories = [fixedCategory];
  const [groups, categories] = await Promise.all([getSetting(db, "tags"), getSetting(db, "categories")]);
  const result = await browse(db, filters, groups);
  const lastPage = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
  const redirect = filters.page > lastPage ? browseHref(base, fixedCategory ? { ...filters, categories: [] } : filters, defaultSort, { page: lastPage }) : undefined;
  return { filters, result, groups, categories, redirect };
}
