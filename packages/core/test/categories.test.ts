import { describe, expect, it } from "vitest";
import { categoryDisplay, categoryInfoSchema } from "../src/categories.ts";

describe("categoryDisplay", () => {
  const info = categoryInfoSchema.parse({
    "review-testing": { label: "Review & testing", hue: "orange", hint: "AI code review", blurb: "Reviews." },
    other: { label: "Other", hue: "stone" },
  });

  it("reads the label, hue, hint and blurb from category_info", () => {
    expect(categoryDisplay("review-testing", info)).toEqual({ slug: "review-testing", label: "Review & testing", hue: "orange", hint: "AI code review", blurb: "Reviews." });
    expect(categoryDisplay("other", info)).toEqual({ slug: "other", label: "Other", hue: "stone", hint: "", blurb: "" });
  });

  it("falls back to the capitalized slug in stone for a category without an entry", () => {
    expect(categoryDisplay("data-tools", info)).toEqual({ slug: "data-tools", label: "Data tools", hue: "stone", hint: "", blurb: "" });
    expect(categoryDisplay("toString", info).hue).toBe("stone");
  });

  it("rejects hues outside the palette and blank labels", () => {
    expect(categoryInfoSchema.safeParse({ cli: { label: "CLI", hue: "lime" } }).success).toBe(false);
    expect(categoryInfoSchema.safeParse({ cli: { label: " ", hue: "amber" } }).success).toBe(false);
  });
});
