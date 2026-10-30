import { z } from "zod";

// Display names, colors and descriptions for the categories setting live in the
// `category_info` setting (see docs/UI-HANDOFF.md), edited on /admin/taxonomy. A
// category without an entry shows its slug, capitalized and in stone, and the
// classifier sees no description for it.

/** Tailwind hues a category may use. Lime and emerald are reserved for brand and OK. */
export const CATEGORY_HUES = [
  "violet", "indigo", "sky", "rose", "orange", "cyan", "blue", "amber", "teal", "pink", "fuchsia", "yellow", "green", "stone",
] as const;
export type CategoryHue = (typeof CATEGORY_HUES)[number];

/** Per category: its label and color on pages, the one-line description the classifier sees, and the public blurb. */
export const categoryInfoSchema = z.record(
  z.string(),
  z.object({
    label: z.string().trim().min(1),
    hue: z.enum(CATEGORY_HUES),
    // For the classifier prompt: what belongs in this category, and what goes elsewhere.
    hint: z.string().trim().default(""),
    // For visitors: the category page's one-line description.
    blurb: z.string().trim().default(""),
  }),
);
export type CategoryInfo = z.infer<typeof categoryInfoSchema>;

export interface CategoryDisplay {
  slug: string;
  label: string;
  hue: CategoryHue;
  hint: string;
  blurb: string;
}

export function categoryDisplay(slug: string, info: CategoryInfo): CategoryDisplay {
  const known = Object.hasOwn(info, slug) ? info[slug] : undefined;
  const fallback = slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, " ");
  return { slug, label: known?.label ?? fallback, hue: known?.hue ?? "stone", hint: known?.hint ?? "", blurb: known?.blurb ?? "" };
}
