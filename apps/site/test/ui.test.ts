import { describe, expect, it } from "vitest";
import { aboutDuration, confidenceChip, githubHref, num, safeHref, shortDuration } from "../src/lib/ui.ts";
import { buildInfo } from "../src/lib/version.ts";

describe("link helpers", () => {
  it("links http(s) homepages only", () => {
    expect(safeHref("https://patchwork.dev/")).toBe("https://patchwork.dev/");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,x")).toBeNull();
    expect(safeHref(null)).toBeNull();
  });

  it("turns owner/repo into a GitHub URL", () => {
    expect(githubHref("acme/patchwork")).toBe("https://github.com/acme/patchwork");
    expect(githubHref("acme/patch work")).toBeNull();
    expect(githubHref("https://evil.example/x")).toBeNull();
    expect(githubHref(null)).toBeNull();
  });
});

describe("confidenceChip", () => {
  it("rounds to a percent and colors by band", () => {
    expect(confidenceChip(0.9)).toEqual({ text: "90%", class: "bg-emerald-50 text-emerald-700" });
    expect(confidenceChip(0.7).class).toContain("amber");
    expect(confidenceChip(0.694).text).toBe("69%");
    expect(confidenceChip(0.69).class).toContain("red");
    expect(confidenceChip(null).text).toBe("no score");
  });
});

describe("aboutDuration", () => {
  it("rounds to minutes, hours or days", () => {
    expect(aboutDuration(0.2)).toBe("about 1 minute");
    expect(aboutDuration(45)).toBe("about 45 minutes");
    expect(aboutDuration(150)).toBe("about 3 hours");
    expect(aboutDuration(5 * 1440)).toBe("about 5 days");
  });
});

describe("num", () => {
  it("adds thousands separators", () => {
    expect(num(7)).toBe("7");
    expect(num(28_431)).toBe("28,431");
  });
});

describe("shortDuration", () => {
  it("shows seconds, minutes or hours", () => {
    expect(shortDuration(400)).toBe("0s");
    expect(shortDuration(9_000)).toBe("9s");
    expect(shortDuration(90_000)).toBe("1m 30s");
    expect(shortDuration(120_000)).toBe("2m");
    expect(shortDuration(7_500_000)).toBe("2h 5m");
    expect(shortDuration(-5)).toBe("0s");
  });
});

describe("buildInfo", () => {
  it("reads the commit from the version tag", () => {
    const info = buildInfo({ id: "0c3f4f0e-1b2a-4c5d-8e9f-0a1b2c3d4e5f", tag: "a1b2c3d4e5f6", timestamp: "2026-10-12T06:00:00.000Z" });
    expect(info.commit).toBe("a1b2c3d4e5f6");
    expect(info.commitHref).toBe("https://github.com/andyshinn/slopbucket/commit/a1b2c3d4e5f6");
    expect(info.versionId).toBe("0c3f4f0e-1b2a-4c5d-8e9f-0a1b2c3d4e5f");
  });

  const meta = (tag: string | undefined) => ({ id: "0c3f4f0e-1b2a-4c5d-8e9f-0a1b2c3d4e5f", tag, timestamp: "2026-10-12T06:00:00.000Z" }) as WorkerVersionMetadata;

  it("shortens the version ID", () => {
    expect(buildInfo(meta("a1b2c3d")).versionShort).toBe("0c3f4f0e");
  });

  it.each([
    ["untagged", undefined],
    ["empty", ""],
    ["six characters", "a1b2c3"],
    ["41 characters", "a".repeat(41)],
    ["uppercase hex", "A1B2C3D4E5F6"],
    ["not hex", "<script>"],
  ])("has no commit for a tag that is %s", (_, tag) => {
    const info = buildInfo(meta(tag));
    expect(info.commit).toBeNull();
    expect(info.commitHref).toBeNull();
  });

  it.each([["seven characters", "a1b2c3d"], ["40 characters", "a".repeat(40)]])("accepts a commit of %s", (_, tag) => {
    expect(buildInfo(meta(tag)).commit).toBe(tag);
  });
});
