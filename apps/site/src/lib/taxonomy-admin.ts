import { CATEGORY_HUES, type CategoryDisplay, type CategoryHue, type CategoryInfo, categoryDisplay, getSetting, settingSchemas } from "@slop-bucket/core";

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

const slugify = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

interface CategoryFields {
  slug: string;
  label: string;
  hue: CategoryHue;
  hint: string;
  blurb: string;
}

function readFields(form: FormData): CategoryFields {
  const str = (k: string) => String(form.get(k) ?? "").trim().replace(/\s+/g, " ");
  const slug = slugify(str("slug"));
  if (!slug) throw new TaxonomyError("Give it a slug: lowercase letters, digits and hyphens.");
  const label = str("label");
  if (!label) throw new TaxonomyError("Give it a label.");
  const hue = str("hue");
  if (!(CATEGORY_HUES as readonly string[]).includes(hue)) throw new TaxonomyError("Pick a color.");
  return { slug, label, hue: hue as CategoryHue, hint: str("hint"), blurb: str("blurb") };
}

/** Statements that save both settings, validated with the Worker's schemas first. */
function saveStatements(db: D1Database, categories: string[], info: CategoryInfo): D1PreparedStatement[] {
  const list = settingSchemas.categories.safeParse(categories);
  if (!list.success) throw new TaxonomyError(list.error.issues.map((i) => i.message).join("; "));
  const details = settingSchemas.category_info.parse(info);
  const save = "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value";
  return [db.prepare(save).bind("categories", JSON.stringify(list.data)), db.prepare(save).bind("category_info", JSON.stringify(details))];
}

/** Statements that move everything stored under one category to another. */
function moveStatements(db: D1Database, from: string, into: string): D1PreparedStatement[] {
  return [
    db.prepare("UPDATE tools SET category = ?2 WHERE category = ?1").bind(from, into),
    db
      .prepare("UPDATE posts SET classification = json_set(classification, '$.category', ?2) WHERE json_extract(classification, '$.category') = ?1")
      .bind(from, into),
    db
      .prepare("UPDATE review_decisions SET corrected_fields = json_set(corrected_fields, '$.category', ?2) WHERE json_extract(corrected_fields, '$.category') = ?1")
      .bind(from, into),
  ];
}

async function load(db: D1Database) {
  const [categories, info] = await Promise.all([getSetting(db, "categories"), getSetting(db, "category_info")]);
  return { categories: [...categories], info: { ...info } };
}

/** Adds a category just above "other", which always stays last. Returns its slug. */
export async function addCategory(db: D1Database, form: FormData): Promise<string> {
  const { slug, ...details } = readFields(form);
  const { categories, info } = await load(db);
  if (categories.includes(slug)) throw new TaxonomyError(`"${slug}" is already a category.`);
  const at = categories.indexOf(OTHER);
  categories.splice(at === -1 ? categories.length : at, 0, slug);
  info[slug] = details;
  await db.batch(saveStatements(db, categories, info));
  return slug;
}

/** Saves a category's details. A new slug renames it, moving its tools and posts along. Returns the slug. */
export async function updateCategory(db: D1Database, slug: string, form: FormData): Promise<string> {
  const { slug: newSlug, ...details } = readFields(form);
  const { categories, info } = await load(db);
  const at = categories.indexOf(slug);
  if (at === -1) throw new TaxonomyError(`"${slug}" is not a category.`);
  const renamed = newSlug !== slug;
  if (renamed && slug === OTHER) throw new TaxonomyError('"other" can\'t be renamed: the classifier and the review rules rely on it.');
  if (renamed && categories.includes(newSlug)) throw new TaxonomyError(`"${newSlug}" is already a category. To combine them, use Merge.`);
  categories[at] = newSlug;
  delete info[slug];
  info[newSlug] = details;
  await db.batch([...saveStatements(db, categories, info), ...(renamed ? moveStatements(db, slug, newSlug) : [])]);
  return newSlug;
}

/** Moves a category one place up or down the list; "other" stays last. */
export async function reorderCategory(db: D1Database, slug: string, direction: "up" | "down"): Promise<void> {
  const { categories, info } = await load(db);
  const at = categories.indexOf(slug);
  const to = direction === "up" ? at - 1 : at + 1;
  if (at === -1 || slug === OTHER || to < 0 || to >= categories.length || categories[to] === OTHER) return;
  [categories[at], categories[to]] = [categories[to]!, categories[at]!];
  await db.batch(saveStatements(db, categories, info));
}

/**
 * Removes a category from the list after moving its tools, posts and review corrections
 * into another one. Also takes a slug that is no longer in the list (an orphan), to move
 * what is still stored under it.
 */
export async function mergeCategory(db: D1Database, slug: string, into: string): Promise<void> {
  const { categories, info } = await load(db);
  if (slug === OTHER) throw new TaxonomyError('"other" can\'t be removed.');
  if (!categories.includes(into)) throw new TaxonomyError("Pick a category to move them into.");
  if (into === slug) throw new TaxonomyError("Pick a different category to move them into.");
  const remaining = categories.filter((c) => c !== slug);
  delete info[slug];
  await db.batch([...moveStatements(db, slug, into), ...saveStatements(db, remaining, info)]);
}
