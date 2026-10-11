// Display names and colors for the categories setting (see docs/UI-HANDOFF.md).
// The list itself lives in settings; a category added there without an entry
// here shows its slug, capitalized and in stone, until code adds a label.

/** Tailwind hues a category may use. Lime and emerald are reserved for brand and OK. */
export type CategoryHue =
  | "violet" | "indigo" | "sky" | "rose" | "orange" | "cyan" | "blue" | "amber" | "teal" | "pink" | "stone";

const CATEGORY_DISPLAY: Record<string, { label: string; hue: CategoryHue; blurb: string }> = {
  agent: { label: "Agent", hue: "violet", blurb: "Coding agents that plan and make changes on their own." },
  "agent-addon": { label: "Agent add-on", hue: "indigo", blurb: "Plugins, skills, hooks, status lines and rule packs you install into a coding agent." },
  "agent-tools": { label: "Agent tools", hue: "sky", blurb: "Tools that run alongside coding agents: parallel runs, dashboards, cost tracking, sandboxes." },
  "agent-security": { label: "Agent security", hue: "rose", blurb: "Guardrails, command blocking, secret scanning and audit trails for coding agents." },
  "review-testing": { label: "Review & testing", hue: "orange", blurb: "AI code review, test generation, and checking what the AI wrote." },
  "memory-context": { label: "Memory & context", hue: "cyan", blurb: "Memory, codebase indexes and context trimming for coding agents." },
  ide: { label: "IDE", hue: "blue", blurb: "AI editors and editor extensions." },
  cli: { label: "CLI", hue: "amber", blurb: "AI command-line tools that fit nowhere more specific." },
  "mcp-dev": { label: "MCP · dev", hue: "teal", blurb: "MCP servers for software development." },
  "mcp-general": { label: "MCP · general", hue: "pink", blurb: "MCP servers for everything else." },
  other: { label: "Other", hue: "stone", blurb: "AI dev tools that fit no other category yet." },
};

export function categoryDisplay(slug: string): { slug: string; label: string; hue: CategoryHue; blurb: string } {
  const known = Object.hasOwn(CATEGORY_DISPLAY, slug) ? CATEGORY_DISPLAY[slug] : undefined;
  const fallback = slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, " ");
  return { slug, label: known?.label ?? fallback, hue: known?.hue ?? "stone", blurb: known?.blurb ?? "" };
}
