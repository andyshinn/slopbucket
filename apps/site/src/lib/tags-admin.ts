import { type TagGroups, parseSetting, settingSchemas, tagSlugs } from "@slop-bucket/core";
import { TaxonomyError, slugify } from "./taxonomy-admin.ts";

// Tags on /admin/taxonomy. The `tags` setting is the vocabulary: groups of tags, in display
// order, that the classifier may choose from. Renames, merges, deletes and mapped suggestions
// also rewrite the tags stored on tools, in posts' classifications and in review corrections,
// all in one batch with the setting.

export interface TagRow {
  slug: string;
  label: string;
  /** Tools with this tag that aren't hidden. */
  tools: number;
}

export interface TagGroupRow {
  slug: string;
  label: string;
  hint: string;
  tags: TagRow[];
}

export interface TagOverview {
  groups: TagGroupRow[];
  /** Tags the classifier asked for that aren't in the vocabulary, most requested first. */
  suggestions: { tag: string; posts: number }[];
  /** Tags still stored on tools that aren't hidden, but not in the vocabulary. */
  orphans: { tag: string; tools: number }[];
}

/** Tags the classifier asked for on queued or published posts, most requested first. */
export async function suggestedTags(db: D1Database, limit = 40): Promise<{ tag: string; posts: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT lower(j.value) AS tag, count(*) AS posts
       FROM posts p, json_each(p.classification, '$.suggested_tags') j
       WHERE p.status IN ('queued', 'published') AND p.classification IS NOT NULL
       GROUP BY 1 ORDER BY posts DESC, tag LIMIT ?`,
    )
    .bind(limit)
    .all<{ tag: string; posts: number }>();
  return results;
}

export async function tagOverview(db: D1Database): Promise<TagOverview> {
  const [{ groups }, counts, suggested] = await Promise.all([
    loadTagSettings(db),
    db
      .prepare("SELECT j.value AS tag, count(*) AS n FROM tools t, json_each(t.tags) j WHERE t.status != 'hidden' GROUP BY 1")
      .all<{ tag: string; n: number }>(),
    suggestedTags(db),
  ]);
  const tools = new Map(counts.results.map((r) => [r.tag, r.n]));
  const vocabulary = new Set(tagSlugs(groups));
  return {
    groups: groups.map((g) => ({ ...g, tags: g.tags.map((t) => ({ ...t, tools: tools.get(t.slug) ?? 0 })) })),
    // A suggestion can name a tag added since; Add already moved those posts' suggestions over.
    suggestions: suggested.filter((s) => !vocabulary.has(s.tag)).slice(0, 20),
    orphans: [...tools].filter(([tag]) => !vocabulary.has(tag)).map(([tag, n]) => ({ tag, tools: n })).sort((a, b) => b.tools - a.tools || a.tag.localeCompare(b.tag)),
  };
}

/** The vocabulary as read, with its stored JSON so a save can check nobody changed it since. */
export interface TagSettings {
  groups: TagGroups;
  stored: string;
}

export async function loadTagSettings(db: D1Database): Promise<TagSettings> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'tags'").first<{ value: string }>();
  if (!row) throw new Error("Missing setting: tags");
  return { groups: structuredClone(parseSetting("tags", row.value)), stored: row.value };
}

// True while the setting still holds what was read; binds ?3.
const UNCHANGED = "(SELECT value FROM settings WHERE key = 'tags') = ?3";

// A JSON array from json_each(source) with tag ?1 swapped for ?2 (dropped when ?2 is NULL),
// in the original order and without duplicates.
const swapped = (source: string) =>
  `json((SELECT json_group_array(v) FROM (
     SELECT CASE WHEN value = ?1 THEN ?2 ELSE value END AS v, min(key) AS k FROM json_each(${source})
     WHERE value != ?1 OR ?2 IS NOT NULL GROUP BY v ORDER BY k)))`;
// A JSON array from json_each(source) with ?2 added at the end, once (unchanged when ?2 is NULL).
const appended = (source: string) =>
  `json((SELECT json_group_array(v) FROM (
     SELECT value AS v, key AS k FROM json_each(${source}) WHERE ?2 IS NULL OR value != ?2
     UNION ALL SELECT ?2, 1e9 WHERE ?2 IS NOT NULL ORDER BY k)))`;
const has = (source: string, param: "?1" | "?2") => `EXISTS (SELECT 1 FROM json_each(${source}) WHERE value = ${param})`;

/**
 * Statements that move stored tag `from` to `into`, or remove it when `into` is null:
 * on tools, in posts' classified tags and in review corrections. A post that suggested
 * `from` gets `into` as a tag instead (and so does its tool, if the post is queued or
 * published), and the suggestion goes. Each one applies only while the setting is unchanged.
 */
function retag(db: D1Database, guard: string, from: string, into: string | null): D1PreparedStatement[] {
  return [
    // Before the suggestions are cleared below.
    `UPDATE tools SET tags = ${appended("tools.tags")}
     WHERE ?2 IS NOT NULL AND NOT ${has("tools.tags", "?2")} AND id IN (
       SELECT p.tool_id FROM posts p, json_each(p.classification, '$.suggested_tags') j
       WHERE p.status IN ('queued', 'published') AND lower(j.value) = ?1)`,
    `UPDATE tools SET tags = ${swapped("tools.tags")} WHERE ${has("tools.tags", "?1")}`,
    `UPDATE posts SET classification = json_set(classification, '$.tags', ${swapped("posts.classification, '$.tags'")})
     WHERE ${has("posts.classification, '$.tags'", "?1")}`,
    `UPDATE posts SET classification = json_set(classification,
       '$.suggested_tags', json((SELECT json_group_array(value) FROM json_each(posts.classification, '$.suggested_tags') WHERE lower(value) != ?1)),
       '$.tags', ${appended("posts.classification, '$.tags'")})
     WHERE EXISTS (SELECT 1 FROM json_each(posts.classification, '$.suggested_tags') WHERE lower(value) = ?1)`,
    `UPDATE review_decisions SET corrected_fields = json_set(corrected_fields, '$.tags', ${swapped("review_decisions.corrected_fields, '$.tags'")})
     WHERE ${has("review_decisions.corrected_fields, '$.tags'", "?1")}`,
  ].map((sql) => db.prepare(`${sql} AND ${UNCHANGED}`).bind(from, into, guard));
}

/**
 * Saves the vocabulary and applies `moves` (see retag) in one batch. Every statement only
 * applies if the setting is still what `read` saw (another tab, a double tap), so a stale
 * edit changes nothing and throws instead of overwriting.
 */
export async function saveTagSettings(db: D1Database, read: TagSettings, groups: TagGroups, moves: { from: string; into: string | null }[] = []): Promise<void> {
  const parsed = settingSchemas.tags.safeParse(groups);
  if (!parsed.success) throw new TaxonomyError(parsed.error.issues.map((i) => i.message).join("; "));
  const statements = moves.flatMap((m) => retag(db, read.stored, m.from, m.into));
  // Last, so the moves above still see the setting as read.
  statements.push(db.prepare("UPDATE settings SET value = ?1 WHERE key = 'tags' AND value = ?2").bind(JSON.stringify(parsed.data), read.stored));
  const results = await db.batch(statements);
  if (results.at(-1)!.meta.changes === 0) throw new TaxonomyError("Tags changed somewhere else while you were editing. Reload and try again.");
}

/** The fields of the tag add and edit forms. */
export const TAG_FIELD_KEYS = ["label", "slug", "group"] as const;
export type TagFieldValues = Record<(typeof TAG_FIELD_KEYS)[number], string>;

/** The form's fields as submitted (blank when missing), to re-show them after an error. */
export function tagFieldsFromForm(form: FormData | null): TagFieldValues {
  return Object.fromEntries(TAG_FIELD_KEYS.map((k) => [k, String(form?.get(k) ?? "")])) as TagFieldValues;
}

const clean = (s: string) => s.trim().replace(/\s+/g, " ");

function readTagFields(form: FormData, groups: TagGroups): { label: string; slug: string; group: TagGroups[number] } {
  const raw = tagFieldsFromForm(form);
  const label = clean(raw.label);
  const slug = slugify(raw.slug || raw.label);
  const group = groups.find((g) => g.slug === raw.group);
  if (!label) throw new TaxonomyError("Give it a label.");
  if (!slug) throw new TaxonomyError("Give it a slug: lowercase letters, digits and hyphens.");
  if (!group) throw new TaxonomyError("Pick a group.");
  return { label, slug, group };
}

/** Where a tag sits: its group and its index in that group. */
function locate(groups: TagGroups, slug: string) {
  for (const group of groups) {
    const at = group.tags.findIndex((t) => t.slug === slug);
    if (at !== -1) return { group, at };
  }
  throw new TaxonomyError(`"${slug}" is not a tag.`);
}

/** Removes a tag from its group, and the group too once it has no tags left. */
function removeTag(groups: TagGroups, slug: string): TagGroups {
  const { group, at } = locate(groups, slug);
  group.tags.splice(at, 1);
  return groups.filter((g) => g.tags.length > 0);
}

/**
 * Adds a tag at the end of its group. Posts that suggested it (or `suggestion`, the
 * classifier's spelling it was added from) get it as a tag now, and so do their tools.
 * Returns its slug.
 */
export async function addTag(db: D1Database, form: FormData): Promise<string> {
  const read = await loadTagSettings(db);
  const { label, slug, group } = readTagFields(form, read.groups);
  if (tagSlugs(read.groups).includes(slug)) throw new TaxonomyError(`"${slug}" is already a tag.`);
  group.tags.push({ slug, label });
  const suggestion = clean(String(form.get("suggestion") ?? "")).toLowerCase();
  const froms = [...new Set([slug, suggestion].filter(Boolean))];
  await saveTagSettings(db, read, read.groups, froms.map((from) => ({ from, into: slug })));
  return slug;
}

/**
 * Saves a tag's label and group (moving to another group puts it last there). A new slug
 * renames it, moving it along on tools, posts and review corrections. Returns the slug.
 */
export async function updateTag(db: D1Database, slug: string, form: FormData): Promise<string> {
  const read = await loadTagSettings(db);
  const { label, slug: newSlug, group } = readTagFields(form, read.groups);
  const { group: current, at } = locate(read.groups, slug);
  const renamed = newSlug !== slug;
  if (renamed && tagSlugs(read.groups).includes(newSlug)) throw new TaxonomyError(`"${newSlug}" is already a tag. To combine them, use Merge.`);
  const tag = { slug: newSlug, label };
  if (group === current) current.tags[at] = tag;
  else {
    current.tags.splice(at, 1);
    group.tags.push(tag);
  }
  const groups = read.groups.filter((g) => g.tags.length > 0);
  await saveTagSettings(db, read, groups, renamed ? [{ from: slug, into: newSlug }] : []);
  return newSlug;
}

/** Whether a tag or group can move one place up or down its list. */
export function canMoveIn(list: readonly { slug: string }[], slug: string, direction: "up" | "down"): boolean {
  const at = list.findIndex((x) => x.slug === slug);
  const to = direction === "up" ? at - 1 : at + 1;
  return at !== -1 && to >= 0 && to < list.length;
}

function swap<T extends { slug: string }>(list: T[], slug: string, direction: "up" | "down") {
  const at = list.findIndex((x) => x.slug === slug);
  const to = direction === "up" ? at - 1 : at + 1;
  [list[at], list[to]] = [list[to]!, list[at]!];
}

/** Moves a tag one place up or down within its group: the order in filters and in the prompt. */
export async function reorderTag(db: D1Database, slug: string, direction: "up" | "down"): Promise<void> {
  const read = await loadTagSettings(db);
  const { group } = locate(read.groups, slug);
  if (!canMoveIn(group.tags, slug, direction)) return;
  swap(group.tags, slug, direction);
  await saveTagSettings(db, read, read.groups);
}

/** Replaces a tag with another one on tools, posts and review corrections, then removes it. */
export async function mergeTag(db: D1Database, slug: string, into: string): Promise<void> {
  const read = await loadTagSettings(db);
  if (into === slug) throw new TaxonomyError("Pick a different tag to merge it into.");
  if (!tagSlugs(read.groups).includes(into)) throw new TaxonomyError("Pick a tag to merge it into.");
  await saveTagSettings(db, read, removeTag(read.groups, slug), [{ from: slug, into }]);
}

/** Removes a tag from the vocabulary and from every tool, post and review correction. */
export async function deleteTag(db: D1Database, slug: string): Promise<void> {
  const read = await loadTagSettings(db);
  await saveTagSettings(db, read, removeTag(read.groups, slug), [{ from: slug, into: null }]);
}

/**
 * For a tag outside the vocabulary (a suggestion, or a tag left on tools): gives the posts
 * and tools that have it `into` instead, or just drops it when `into` is null. The
 * vocabulary stays as it is.
 */
export async function mapTag(db: D1Database, from: string, into: string | null): Promise<void> {
  const read = await loadTagSettings(db);
  const vocabulary = tagSlugs(read.groups);
  if (!from) throw new TaxonomyError("Pick a tag to map.");
  if (vocabulary.includes(from)) throw new TaxonomyError(`"${from}" is in your tag list. Edit it there instead.`);
  if (into !== null && !vocabulary.includes(into)) throw new TaxonomyError("Pick a tag from your list to map it to.");
  await saveTagSettings(db, read, read.groups, [{ from, into }]);
}

/** The fields of the group add and edit forms; adding also takes the group's first tag. */
export const GROUP_FIELD_KEYS = ["label", "hint", "tag_label", "tag_slug"] as const;
export type GroupFieldValues = Record<(typeof GROUP_FIELD_KEYS)[number], string>;

export function groupFieldsFromForm(form: FormData | null): GroupFieldValues {
  return Object.fromEntries(GROUP_FIELD_KEYS.map((k) => [k, String(form?.get(k) ?? "")])) as GroupFieldValues;
}

/** Adds a group at the end, with its first tag (a group can't be empty). Returns its slug. */
export async function addGroup(db: D1Database, form: FormData): Promise<string> {
  const read = await loadTagSettings(db);
  const f = groupFieldsFromForm(form);
  const label = clean(f.label);
  const slug = slugify(label);
  const tag = { label: clean(f.tag_label), slug: slugify(f.tag_slug || f.tag_label) };
  if (!slug) throw new TaxonomyError("Give the group a name.");
  if (read.groups.some((g) => g.slug === slug)) throw new TaxonomyError(`There is already a "${label}" group.`);
  if (!tag.label || !tag.slug) throw new TaxonomyError("Give it a first tag: a group can't be empty.");
  if (tagSlugs(read.groups).includes(tag.slug)) throw new TaxonomyError(`"${tag.slug}" is already a tag.`);
  read.groups.push({ slug, label, hint: clean(f.hint), tags: [tag] });
  await saveTagSettings(db, read, read.groups, [{ from: tag.slug, into: tag.slug }]);
  return slug;
}

/** Saves a group's label and hint. Its slug stays: it only names the group inside the app. */
export async function updateGroup(db: D1Database, slug: string, form: FormData): Promise<void> {
  const read = await loadTagSettings(db);
  const group = read.groups.find((g) => g.slug === slug);
  if (!group) throw new TaxonomyError(`"${slug}" is not a group.`);
  const f = groupFieldsFromForm(form);
  group.label = clean(f.label);
  group.hint = clean(f.hint);
  if (!group.label) throw new TaxonomyError("Give the group a name.");
  await saveTagSettings(db, read, read.groups);
}

/** Moves a group one place up or down: the order in filters and in the prompt. */
export async function reorderGroup(db: D1Database, slug: string, direction: "up" | "down"): Promise<void> {
  const read = await loadTagSettings(db);
  if (!canMoveIn(read.groups, slug, direction)) return;
  swap(read.groups, slug, direction);
  await saveTagSettings(db, read, read.groups);
}
