import { describe, expect, it } from "vitest";
import { aboutDuration, githubHref, safeHref } from "../src/lib/ui.ts";
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

describe("aboutDuration", () => {
  it("rounds to minutes, hours or days", () => {
    expect(aboutDuration(0.2)).toBe("about 1 minute");
    expect(aboutDuration(45)).toBe("about 45 minutes");
    expect(aboutDuration(150)).toBe("about 3 hours");
    expect(aboutDuration(5 * 1440)).toBe("about 5 days");
  });
});

describe("buildInfo", () => {
  it("reads the commit from the version tag", () => {
    const info = buildInfo({ id: "0c3f4f0e-1b2a-4c5d-8e9f-0a1b2c3d4e5f", tag: "a1b2c3d4e5f6", timestamp: "2026-10-12T06:00:00.000Z" });
    expect(info.commit).toBe("a1b2c3d4e5f6");
    expect(info.commitHref).toBe("https://github.com/andyshinn/slopbucket/commit/a1b2c3d4e5f6");
    expect(info.versionId).toBe("0c3f4f0e-1b2a-4c5d-8e9f-0a1b2c3d4e5f");
  });

  it("has no commit for an untagged or odd tag", () => {
    expect(buildInfo({ id: "x", tag: "", timestamp: "" }).commit).toBeNull();
    expect(buildInfo({ id: "x", tag: "<script>", timestamp: "" }).commitHref).toBeNull();
  });
});
