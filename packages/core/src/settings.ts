import { z } from "zod";
import { categoryInfoSchema } from "./categories.ts";

const slug = z.string().regex(/^[a-z0-9-]+$/, "lowercase letters, digits and hyphens");

/** The tag vocabulary: groups of tags the classifier may choose from. */
export const tagGroupsSchema = z
  .array(
    z.object({
      slug,
      label: z.string().trim().min(1),
      // What the group means, for the classifier prompt (e.g. "where it runs").
      hint: z.string().trim().default(""),
      tags: z.array(z.object({ slug, label: z.string().trim().min(1) })).min(1),
    }),
  )
  .min(1)
  .refine((groups) => new Set(groups.map((g) => g.slug)).size === groups.length, { message: "group names must be unique" })
  .refine(
    (groups) => {
      const slugs = groups.flatMap((g) => g.tags.map((t) => t.slug));
      return new Set(slugs).size === slugs.length;
    },
    { message: "each tag may appear only once, across all groups" },
  );
export type TagGroups = z.infer<typeof tagGroupsSchema>;

/** Every tag slug in the vocabulary. */
export const tagSlugs = (groups: TagGroups): string[] => groups.flatMap((g) => g.tags.map((t) => t.slug));

// Every tunable value lives in the `settings` table as JSON. Defaults are
// seeded by migrations, never hard-coded in Worker code.
export const settingSchemas = {
  review_threshold: z.number().min(0).max(1),
  trending_weights: z.object({
    w_s: z.number(),
    w_e: z.number(),
    w_g: z.number(),
    g: z.number(),
  }),
  categories: z
    .array(slug)
    .min(1)
    .refine((c) => c.includes("other"), { message: 'must include "other"' })
    .refine((c) => new Set(c).size === c.length, { message: "no duplicates" }),
  // Labels, colors, classifier descriptions and public blurbs, keyed by category slug.
  category_info: categoryInfoSchema,
  prefilter_keywords: z.array(z.string().min(1)),
  model_id: z.string().min(1),
  // For reasoning models, e.g. "low"; "" sends no reasoning_effort.
  model_reasoning_effort: z.string(),
  max_fewshot: z.number().int().min(0),
  // GitHub adapter: repos with any of these topics and at least this many stars.
  github_topics: z.array(z.string().min(1)).min(1),
  github_min_stars: z.number().int().min(0),
  tags: tagGroupsSchema,
} as const;

export type SettingKey = keyof typeof settingSchemas;
export type SettingValue<K extends SettingKey> = z.infer<(typeof settingSchemas)[K]>;

export const SETTING_KEYS = Object.keys(settingSchemas) as SettingKey[];

export function parseSetting<K extends SettingKey>(key: K, raw: string): SettingValue<K> {
  return settingSchemas[key].parse(JSON.parse(raw)) as SettingValue<K>;
}

export async function getSetting<K extends SettingKey>(db: D1Database, key: K): Promise<SettingValue<K>> {
  const row = await db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  if (!row) throw new Error(`Missing setting: ${key}`);
  return parseSetting(key, row.value);
}
