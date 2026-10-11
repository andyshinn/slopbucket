import { describe, expect, it } from "vitest";
import { categoryDisplay } from "../src/categories.ts";

describe("categoryDisplay", () => {
  // Categories v3, as seeded by migrations/0008_categories_v3.sql.
  const v3 = ["agent", "agent-addon", "agent-tools", "agent-security", "review-testing", "memory-context", "ide", "cli", "mcp-dev", "mcp-general"];

  it("gives each v3 category a label and its own hue", () => {
    expect(categoryDisplay("review-testing").label).toBe("Review & testing");
    const hues = v3.map((s) => categoryDisplay(s).hue);
    expect(new Set(hues).size).toBe(hues.length);
    expect(hues).not.toContain("stone");
    expect(categoryDisplay("other")).toEqual({ slug: "other", label: "Other", hue: "stone" });
  });

  it("falls back to the capitalized slug in stone for categories added from settings", () => {
    expect(categoryDisplay("data-tools")).toEqual({ slug: "data-tools", label: "Data tools", hue: "stone" });
    expect(categoryDisplay("toString").hue).toBe("stone");
  });
});
