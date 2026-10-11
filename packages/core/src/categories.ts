// Display names and colors for the categories setting (see docs/UI-HANDOFF.md).
// The list itself lives in settings; a category added there without an entry
// here shows its slug in stone until code adds a label.

/** Tailwind hues a category may use. Lime and emerald are reserved for brand and OK. */
export type CategoryHue =
  | "violet" | "indigo" | "sky" | "rose" | "orange" | "cyan" | "blue" | "amber" | "teal" | "pink" | "stone";

const CATEGORY_DISPLAY: Record<string, { label: string; hue: CategoryHue }> = {
  agent: { label: "Agent", hue: "violet" },
  "agent-addon": { label: "Agent add-on", hue: "indigo" },
  "agent-tools": { label: "Agent tools", hue: "sky" },
  "agent-security": { label: "Agent security", hue: "rose" },
  "review-testing": { label: "Review & testing", hue: "orange" },
  "memory-context": { label: "Memory & context", hue: "cyan" },
  ide: { label: "IDE", hue: "blue" },
  cli: { label: "CLI", hue: "amber" },
  "mcp-dev": { label: "MCP · dev", hue: "teal" },
  "mcp-general": { label: "MCP · general", hue: "pink" },
  other: { label: "Other", hue: "stone" },
};

export function categoryDisplay(slug: string): { slug: string; label: string; hue: CategoryHue } {
  const known = Object.hasOwn(CATEGORY_DISPLAY, slug) ? CATEGORY_DISPLAY[slug] : undefined;
  return { slug, label: known?.label ?? slug, hue: known?.hue ?? "stone" };
}
