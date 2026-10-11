import { type CategoryHue, categoryDisplay } from "@slop-bucket/core";

// Tailwind classes per category hue, written out in full so Tailwind finds them.
// Badge: Tailwind Plus flat badge. Tile: monogram background. Dot: filter dot.
const HUE_CLASSES: Record<CategoryHue, { badge: string; tile: string; dot: string }> = {
  violet: {
    badge: "bg-violet-50 text-violet-700 ring-violet-600/20 dark:bg-violet-400/10 dark:text-violet-300 dark:ring-violet-400/20",
    tile: "bg-violet-100 text-violet-800 dark:bg-violet-500/20 dark:text-violet-200",
    dot: "bg-violet-700 dark:bg-violet-300",
  },
  indigo: {
    badge: "bg-indigo-50 text-indigo-700 ring-indigo-600/20 dark:bg-indigo-400/10 dark:text-indigo-300 dark:ring-indigo-400/20",
    tile: "bg-indigo-100 text-indigo-800 dark:bg-indigo-500/20 dark:text-indigo-200",
    dot: "bg-indigo-700 dark:bg-indigo-300",
  },
  sky: {
    badge: "bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-400/10 dark:text-sky-300 dark:ring-sky-400/20",
    tile: "bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-200",
    dot: "bg-sky-700 dark:bg-sky-300",
  },
  rose: {
    badge: "bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-400/10 dark:text-rose-300 dark:ring-rose-400/20",
    tile: "bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-200",
    dot: "bg-rose-700 dark:bg-rose-300",
  },
  orange: {
    badge: "bg-orange-50 text-orange-700 ring-orange-600/20 dark:bg-orange-400/10 dark:text-orange-300 dark:ring-orange-400/20",
    tile: "bg-orange-100 text-orange-800 dark:bg-orange-500/20 dark:text-orange-200",
    dot: "bg-orange-700 dark:bg-orange-300",
  },
  cyan: {
    badge: "bg-cyan-50 text-cyan-700 ring-cyan-600/20 dark:bg-cyan-400/10 dark:text-cyan-300 dark:ring-cyan-400/20",
    tile: "bg-cyan-100 text-cyan-800 dark:bg-cyan-500/20 dark:text-cyan-200",
    dot: "bg-cyan-700 dark:bg-cyan-300",
  },
  blue: {
    badge: "bg-blue-50 text-blue-700 ring-blue-600/20 dark:bg-blue-400/10 dark:text-blue-300 dark:ring-blue-400/20",
    tile: "bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-200",
    dot: "bg-blue-700 dark:bg-blue-300",
  },
  amber: {
    badge: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-400/10 dark:text-amber-300 dark:ring-amber-400/20",
    tile: "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200",
    dot: "bg-amber-700 dark:bg-amber-300",
  },
  teal: {
    badge: "bg-teal-50 text-teal-700 ring-teal-600/20 dark:bg-teal-400/10 dark:text-teal-300 dark:ring-teal-400/20",
    tile: "bg-teal-100 text-teal-800 dark:bg-teal-500/20 dark:text-teal-200",
    dot: "bg-teal-700 dark:bg-teal-300",
  },
  pink: {
    badge: "bg-pink-50 text-pink-700 ring-pink-600/20 dark:bg-pink-400/10 dark:text-pink-300 dark:ring-pink-400/20",
    tile: "bg-pink-100 text-pink-800 dark:bg-pink-500/20 dark:text-pink-200",
    dot: "bg-pink-700 dark:bg-pink-300",
  },
  stone: {
    badge: "bg-stone-50 text-stone-700 ring-stone-600/20 dark:bg-stone-400/10 dark:text-stone-300 dark:ring-stone-400/20",
    tile: "bg-stone-100 text-stone-800 dark:bg-stone-500/20 dark:text-stone-200",
    dot: "bg-stone-700 dark:bg-stone-300",
  },
};

/** A category's label plus the classes for its badge, monogram tile and filter dot. */
export function categoryStyle(slug: string) {
  const { label, hue } = categoryDisplay(slug);
  return { slug, label, hue, ...HUE_CLASSES[hue] };
}
