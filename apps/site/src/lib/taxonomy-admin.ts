import { CATEGORY_HUES, type CategoryDisplay, type CategoryHue, type CategoryInfo, categoryDisplay, getSetting, parseSetting, settingSchemas } from "@slop-bucket/core";

// Categories on /admin/taxonomy. The `categories` setting is the list (the classifier's
// enum and the display order) and `category_info` holds each one's label, color,
// classifier hint and public blurb. Renames and merges also rewrite the category stored
// on tools, on posts' classifications and in review corrections, all in one batch.

export class TaxonomyError extends Error {}

export const OTHER = "other";
/** Warn when "other" holds more than this share of tools: the list needs another category. */
export const OTHER_WARN_SHARE = 0.2;

export interface CategoryRow extends CategoryDisplay {
  /** Tools in this category that aren't hidden. */
  tools: number;
  /** Queued posts the model put in this category. */
  queued: number;
}

export interface CategoryOverview {
  rows: CategoryRow[];
  /** Categories still stored on tools or queued posts but no longer in the list. */
  orphans: { slug: string; tools: number; queued: number }[];
  /** Tools that aren't hidden, across every category. */
  totalTools: number;
}

export async function categoryOverview(db: D1Database): Promise<CategoryOverview> {
  const [categories, info, toolCounts, postCounts] = await Promise.all([
    getSetting(db, "categories"),
    getSetting(db, "category_info"),
    db.prepare("SELECT category AS slug, count(*) AS n FROM tools WHERE status != 'hidden' AND category IS NOT NULL GROUP BY 1").all<{ slug: string; n: number }>(),
    db
      .prepare("SELECT json_extract(classification, '$.category') AS slug, count(*) AS n FROM posts WHERE status = 'queued' AND classification IS NOT NULL GROUP BY 1")
      .all<{ slug: string | null; n: number }>(),
  ]);
  const tools = new Map(toolCounts.results.map((r) => [r.slug, r.n]));
  const queued = new Map(postCounts.results.filter((r) => r.slug !== null).map((r) => [r.slug!, r.n]));
  const listed = new Set(categories);
  const orphanSlugs = [...new Set([...tools.keys(), ...queued.keys()])].filter((s) => !listed.has(s)).sort();
  return {
    rows: categories.map((slug) => ({ ...categoryDisplay(slug, info), tools: tools.get(slug) ?? 0, queued: queued.get(slug) ?? 0 })),
    orphans: orphanSlugs.map((slug) => ({ slug, tools: tools.get(slug) ?? 0, queued: queued.get(slug) ?? 0 })),
    totalTools: toolCounts.results.reduce((n, r) => n + r.n, 0),
  };
}

/** "other"'s share of tools when it is above the warning line, else null. */
export function otherShare(overview: CategoryOverview): number | null {
  const other = overview.rows.find((r) => r.slug === OTHER);
  if (!other || overview.totalTools === 0) return null;
  const share = other.tools / overview.totalTools;
  return share > OTHER_WARN_SHARE ? share : null;
}

export const slugify = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Slugs the admin's own routes use (`.../new`), so a category, tag or group can't take them. */
const RESERVED_SLUGS = ["new"];

/** Refuses a slug that a static admin route would shadow, leaving that page unreachable. */
export function assertNotReserved(slug: string): void {
  if (RESERVED_SLUGS.includes(slug)) throw new TaxonomyError(`"${slug}" is reserved. Pick another slug.`);
}

/** The fields of the add and edit forms. */
export const CATEGORY_FIELD_KEYS = ["slug", "label", "hue", "hint", "blurb"] as const;
export type CategoryFieldValues = Record<(typeof CATEGORY_FIELD_KEYS)[number], string>;

/** The form's fields as submitted (blank when missing), to re-show them after an error. */
export function fieldsFromForm(form: FormData | null): CategoryFieldValues {
  return Object.fromEntries(CATEGORY_FIELD_KEYS.map((k) => [k, String(form?.get(k) ?? "")])) as CategoryFieldValues;
}

interface CategoryFields extends CategoryFieldValues {
  hue: CategoryHue;
}

function readFields(form: FormData): CategoryFields {
  const raw = fieldsFromForm(form);
  const [slugText, label, hue, hint, blurb] = CATEGORY_FIELD_KEYS.map((k) => raw[k].trim().replace(/\s+/g, " "));
  const slug = slugify(slugText!);
  if (!slug) throw new TaxonomyError("Give it a slug: lowercase letters, digits and hyphens.");
  assertNotReserved(slug);
  if (!label) throw new TaxonomyError("Give it a label.");
  if (!(CATEGORY_HUES as readonly string[]).includes(hue!)) throw new TaxonomyError("Pick a color.");
  return { slug, label, hue: hue as CategoryHue, hint: hint!, blurb: blurb! };
}

/** Where `slug` would move to one place up or down `slugs`, or null when it is at that end or not there. */
function neighbour(slugs: readonly string[], slug: string, direction: "up" | "down"): { at: number; to: number } | null {
  const at = slugs.indexOf(slug);
  const to = direction === "up" ? at - 1 : at + 1;
  return at !== -1 && to >= 0 && to < slugs.length ? { at, to } : null;
}

/** Whether an item can move one place up or down its list (categories, tag groups, tags in a group). */
export function canMoveIn(slugs: readonly string[], slug: string, direction: "up" | "down"): boolean {
  return neighbour(slugs, slug, direction) !== null;
}

/** Swaps the item with that slug and its neighbour, in place (see canMoveIn). */
export function moveIn<T>(list: T[], slugs: readonly string[], slug: string, direction: "up" | "down"): void {
  const n = neighbour(slugs, slug, direction);
  if (n) [list[n.at], list[n.to]] = [list[n.to]!, list[n.at]!];
}

/** Whether a category can move one place up or down: "other" stays last and nothing passes it. */
export function canMove(categories: readonly string[], slug: string, direction: "up" | "down"): boolean {
  const n = neighbour(categories, slug, direction);
  return n !== null && slug !== OTHER && categories[n.to] !== OTHER;
}

/** Both settings as read, with their stored JSON so a save can check nobody changed them since. */
export interface CategorySettings {
  categories: string[];
  info: CategoryInfo;
  stored: { categories: string; info: string };
}

export async function loadCategorySettings(db: D1Database): Promise<CategorySettings> {
  const { results } = await db
    .prepare("SELECT key, value FROM settings WHERE key IN ('categories', 'category_info')")
    .all<{ key: string; value: string }>();
  const stored = (key: string) => {
    const row = results.find((r) => r.key === key);
    if (!row) throw new Error(`Missing setting: ${key}`);
    return row.value;
  };
  const raw = { categories: stored("categories"), info: stored("category_info") };
  return { categories: [...parseSetting("categories", raw.categories)], info: { ...parseSetting("category_info", raw.info) }, stored: raw };
}

// True while both settings still hold what was read; binds ?3 (categories) and ?4 (category_info).
const UNCHANGED = `(SELECT value FROM settings WHERE key = 'categories') = ?3
  AND (SELECT value FROM settings WHERE key = 'category_info') = ?4`;

/**
 * Saves both settings and, when `move` is given, moves everything stored under one category
 * to another, in one batch. Every statement only applies if neither setting changed since
 * `read` (another tab, a double tap, or a Settings save), so a stale edit changes nothing
 * and throws instead of overwriting.
 */
export async function saveCategorySettings(
  db: D1Database,
  read: CategorySettings,
  categories: string[],
  info: CategoryInfo,
  move?: { from: string; into: string },
): Promise<void> {
  const list = settingSchemas.categories.safeParse(categories);
  if (!list.success) throw new TaxonomyError(list.error.issues.map((i) => i.message).join("; "));
  const details = settingSchemas.category_info.parse(info);
  const guard = [read.stored.categories, read.stored.info];
  const moves = move
    ? [
        "UPDATE tools SET category = ?2 WHERE category = ?1",
        "UPDATE posts SET classification = json_set(classification, '$.category', ?2) WHERE json_extract(classification, '$.category') = ?1",
        "UPDATE review_decisions SET corrected_fields = json_set(corrected_fields, '$.category', ?2) WHERE json_extract(corrected_fields, '$.category') = ?1",
      ].map((sql) => db.prepare(`${sql} AND ${UNCHANGED}`).bind(move.from, move.into, ...guard))
    : [];
  // Last, so the moves above still see the values as read.
  const save = db
    .prepare(
      `UPDATE settings SET value = CASE key WHEN 'categories' THEN ?1 ELSE ?2 END
       WHERE key IN ('categories', 'category_info') AND ${UNCHANGED}`,
    )
    .bind(JSON.stringify(list.data), JSON.stringify(details), ...guard);
  const results = await db.batch([...moves, save]);
  if (results.at(-1)!.meta.changes === 0) throw new TaxonomyError("Categories changed somewhere else while you were editing. Reload and try again.");
}

/** Adds a category just above "other", which always stays last. Returns its slug. */
export async function addCategory(db: D1Database, form: FormData): Promise<string> {
  const { slug, ...details } = readFields(form);
  const read = await loadCategorySettings(db);
  const { categories, info } = read;
  if (categories.includes(slug)) throw new TaxonomyError(`"${slug}" is already a category.`);
  const at = categories.indexOf(OTHER);
  categories.splice(at === -1 ? categories.length : at, 0, slug);
  info[slug] = details;
  await saveCategorySettings(db, read, categories, info);
  return slug;
}

/** Saves a category's details. A new slug renames it, moving its tools and posts along. Returns the slug. */
export async function updateCategory(db: D1Database, slug: string, form: FormData): Promise<string> {
  const { slug: newSlug, ...details } = readFields(form);
  const read = await loadCategorySettings(db);
  const { categories, info } = read;
  const at = categories.indexOf(slug);
  if (at === -1) throw new TaxonomyError(`"${slug}" is not a category.`);
  const renamed = newSlug !== slug;
  if (renamed && slug === OTHER) throw new TaxonomyError('"other" can\'t be renamed: the classifier and the review rules rely on it.');
  if (renamed && categories.includes(newSlug)) throw new TaxonomyError(`"${newSlug}" is already a category. To combine them, use Merge.`);
  categories[at] = newSlug;
  delete info[slug];
  info[newSlug] = details;
  await saveCategorySettings(db, read, categories, info, renamed ? { from: slug, into: newSlug } : undefined);
  return newSlug;
}

/** Moves a category one place up or down the list (see canMove). */
export async function reorderCategory(db: D1Database, slug: string, direction: "up" | "down"): Promise<void> {
  const read = await loadCategorySettings(db);
  const { categories, info } = read;
  if (!canMove(categories, slug, direction)) return;
  moveIn(categories, categories, slug, direction);
  await saveCategorySettings(db, read, categories, info);
}

/**
 * Removes a category from the list after moving its tools, posts and review corrections
 * into another one. Also takes a slug that is no longer in the list (an orphan), to move
 * what is still stored under it.
 */
export async function mergeCategory(db: D1Database, slug: string, into: string): Promise<void> {
  const read = await loadCategorySettings(db);
  const { categories, info } = read;
  if (slug === OTHER) throw new TaxonomyError('"other" can\'t be removed.');
  if (!categories.includes(into)) throw new TaxonomyError("Pick a category to move them into.");
  if (into === slug) throw new TaxonomyError("Pick a different category to move them into.");
  delete info[slug];
  await saveCategorySettings(db, read, categories.filter((c) => c !== slug), info, { from: slug, into });
}
