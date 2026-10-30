import { describe, expect, it } from "vitest";
import {
  type NormalizedPost,
  autoPublishes,
  canonicalUrl,
  classificationSchema,
  githubRepoFromUrl,
  isGenericHost,
  normalizeGithubRepo,
  normalizeHomepage,
  normalizeToolName,
  prefilterScore,
  similarity,
  slugify,
} from "../src/index.ts";

describe("canonicalUrl", () => {
  it.each([
    ["https://GitHub.com/Foo/Bar/tree/main/src?tab=readme#x", "https://github.com/foo/bar"],
    ["http://www.example.com/post/?utm_source=hn&b=2&a=1#top", "https://example.com/post?a=1&b=2"],
    ["https://example.com/", "https://example.com"],
    ["https://example.com/a/b/", "https://example.com/a/b"],
    ["https://news.ycombinator.com/item?id=123", "https://news.ycombinator.com/item?id=123"],
  ])("%s -> %s", (input, expected) => {
    expect(canonicalUrl(input)).toBe(expected);
  });
});

describe("GitHub repos", () => {
  it("extracts owner/repo and skips non-repo pages", () => {
    expect(githubRepoFromUrl("https://github.com/rui314/mold/releases/tag/v3.0.0")).toBe("rui314/mold");
    expect(githubRepoFromUrl("https://github.com/marketplace/actions/foo")).toBeNull();
    expect(githubRepoFromUrl("https://github.com/rui314")).toBeNull();
    expect(githubRepoFromUrl("https://gitlab.com/a/b")).toBeNull();
  });

  it("normalizes model output", () => {
    expect(normalizeGithubRepo("Owner/Repo.git")).toBe("owner/repo");
    expect(normalizeGithubRepo("https://github.com/Owner/Repo")).toBe("owner/repo");
    expect(normalizeGithubRepo("github.com/owner/repo")).toBe("owner/repo");
    expect(normalizeGithubRepo("not a repo")).toBeNull();
  });
});

describe("isGenericHost", () => {
  it("treats shared hosts and their subdomains as generic", () => {
    expect(isGenericHost("foo.vercel.app")).toBe(true);
    expect(isGenericHost("medium.com")).toBe(true);
    expect(isGenericHost("cursor.com")).toBe(false);
  });
});

describe("prefilterScore", () => {
  const post = (over: Partial<NormalizedPost>): NormalizedPost => ({
    source: "hn",
    external_id: "1",
    url: "https://example.com/a",
    title: "Unrelated",
    author: null,
    posted_at: "2026-10-05T00:00:00.000Z",
    score: 1,
    comments: 0,
    tags: [],
    ...over,
  });
  const keywords = ["llm", "agent", "ai", "claude code"];

  it("is zero for unrelated posts", () => {
    expect(prefilterScore(post({ title: "Drones over Ukraine" }), keywords)).toBe(0);
  });

  it("matches whole words, simple plurals and phrases", () => {
    expect(prefilterScore(post({ title: "LLMs helped my RSI" }), keywords)).toBe(1);
    expect(prefilterScore(post({ title: "Coding agents, compared" }), keywords)).toBe(1);
    expect(prefilterScore(post({ title: "Tips for Claude Code" }), keywords)).toBe(1);
    expect(prefilterScore(post({ title: "What I said about it" }), keywords)).toBe(0); // "ai" inside "said"
  });

  it("counts the URL host", () => {
    expect(prefilterScore(post({ url: "https://agent.example.dev/" }), keywords)).toBe(1);
  });

  it("adds points for GitHub repos, Show HN and lobste.rs AI tags", () => {
    expect(prefilterScore(post({ url: "https://github.com/a/b" }), keywords)).toBe(1);
    expect(prefilterScore(post({ tags: ["show_hn"] }), keywords)).toBe(1);
    expect(prefilterScore(post({ source: "lobsters", tags: ["vibecoding"] }), keywords)).toBe(1);
  });
});

describe("tool names", () => {
  it("normalizes names", () => {
    expect(normalizeToolName("Claude Code CLI")).toBe("claudecode");
    expect(normalizeToolName("Foo-Bar AI")).toBe("foobar");
    expect(normalizeToolName("AI")).toBe("ai");
  });

  it("scores similarity", () => {
    expect(similarity("opencode", "opencode")).toBe(1);
    expect(similarity("supermaven", "supermavn")).toBeGreaterThanOrEqual(0.9);
    expect(similarity("cursor", "cursr")).toBeLessThan(0.9);
  });

  it("slugifies", () => {
    expect(slugify("Claude Code (beta)!")).toBe("claude-code-beta");
    expect(slugify("???")).toBe("tool");
  });
});

describe("normalizeHomepage", () => {
  it("keeps http(s) URLs and adds https to bare domains", () => {
    expect(normalizeHomepage("https://patchwork.dev/docs")).toBe("https://patchwork.dev/docs");
    expect(normalizeHomepage("patchwork.dev")).toBe("https://patchwork.dev/");
  });

  it("rejects every other scheme and junk", () => {
    expect(normalizeHomepage("javascript:alert(1)")).toBeNull();
    expect(normalizeHomepage("javascript://x.com/%0Aalert(1)")).toBeNull();
    expect(normalizeHomepage("data:text/html,<script>")).toBeNull();
    expect(normalizeHomepage("ftp://files.example.com")).toBeNull();
    expect(normalizeHomepage("not a url")).toBeNull();
  });
});

describe("classificationSchema", () => {
  const schema = classificationSchema(["agent", "ide", "cli", "mcp-dev", "mcp-general", "other"]);
  const valid = {
    is_ai_dev_tool: true,
    post_type: "launch",
    tool_name: " Patchwork ",
    homepage_url: "null",
    github_repo: "https://github.com/Patchwork/Patchwork",
    version: null,
    category: "agent",
    tags: ["Review"],
    is_open_source: true,
    description: "x".repeat(200),
    confidence: 0.8,
  };

  it("normalizes model quirks", () => {
    const out = schema.parse(valid);
    expect(out.tool_name).toBe("Patchwork");
    expect(out.homepage_url).toBeNull();
    expect(out.github_repo).toBe("patchwork/patchwork");
    expect(out.tags).toEqual(["review"]);
    expect(out.description).toHaveLength(140);
  });

  it("rejects categories that are not in settings", () => {
    expect(schema.safeParse({ ...valid, category: "sdk" }).success).toBe(false);
  });

  it("rejects out-of-range confidence", () => {
    expect(schema.safeParse({ ...valid, confidence: 7 }).success).toBe(false);
  });
});

describe("autoPublishes", () => {
  it("publishes at or above the threshold, never for other or a threshold of 1", () => {
    expect(autoPublishes(0.8, 0.8, "agent")).toBe(true);
    expect(autoPublishes(0.8, 0.79, "agent")).toBe(false);
    expect(autoPublishes(0.8, 0.95, "other")).toBe(false);
    expect(autoPublishes(1, 1, "agent")).toBe(false);
    expect(autoPublishes(0, 0, "cli")).toBe(true);
  });
});
