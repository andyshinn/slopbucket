import { describe, expect, it } from "vitest";
import { categoryDisplay } from "../src/categories.ts";

describe("categoryDisplay", () => {
  // Categories v3, as seeded by migrations/0008_categories_v3.sql.
  const v3 = ["agent", "agent-addon", "agent-tools", "agent-security", "review-testing", "memory-context", "ide", "cli", "mcp-dev", "mcp-general"];

  it("labels every v3 category", () => {
    for (const slug of [...v3, "other"]) expect(categoryDisplay(slug).label).not.toBe(slug);
  });

  it("gives each v3 category its own hue", () => {
    const hues = v3.map((s) => categoryDisplay(s).hue);
    expect(new Set(hues).size).toBe(hues.length);
    expect(hues).not.toContain("stone");
  });

  it("falls back to the slug in stone for categories added from settings", () => {
    expect(categoryDisplay("data-tools")).toEqual({ slug: "data-tools", label: "data-tools", hue: "stone" });
    expect(categoryDisplay("toString").hue).toBe("stone");
  });
});
