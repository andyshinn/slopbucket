import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { runClassifyJob } from "../src/classify-job.ts";
import { articleKey } from "../src/content.ts";
import { fakeAi, fakeFetch, json, makeDeps, resetDb } from "./helpers.ts";

beforeEach(resetDb);

const tool = (over: Record<string, unknown> = {}) => ({
  is_ai_dev_tool: true,
  post_type: "launch",
  tool_name: "Patchwork",
  homepage_url: "https://patchwork.dev",
  github_repo: "patchwork-labs/patchwork",
  version: null,
  category: "agent",
  tags: ["review"],
  is_open_source: true,
  description: "Open-source agent that reviews pull requests.",
  confidence: 0.92,
  ...over,
});

let externalId = 0;
async function insertPost(over: { url?: string; title?: string; posted_at?: string } = {}): Promise<number> {
  const url = over.url ?? `https://example.com/post-${++externalId}`;
  const row = await env.DB.prepare(
    "INSERT INTO posts (source, external_id, url, canonical_url, title, posted_at) VALUES ('hn', ?, ?, ?, ?, ?) RETURNING id",
  )
    .bind(String(++externalId), url, url, over.title ?? "Show HN: Patchwork", over.posted_at ?? "2026-10-05T12:00:00.000Z")
    .first<{ id: number }>();
  // Pre-cache text so no network is needed.
  await env.ARTICLES.put(articleKey(row!.id), "Patchwork reviews pull requests with an AI agent.");
  return row!.id;
}

const post = (id: number) =>
  env.DB.prepare("SELECT status, tool_id, confidence, post_type, drop_reason, raw_output, classification FROM posts WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();

const setThreshold = (value: number) =>
  env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'review_threshold'").bind(String(value)).run();

describe("runClassifyJob", () => {
  it("queues for review at threshold 1 and creates a queued tool with aliases", async () => {
    const id = await insertPost();
    const ai = fakeAi(tool({ confidence: 1 }));
    await runClassifyJob({ kind: "classify", post_id: id }, makeDeps({ ai }));

    const p = await post(id);
    expect(p).toMatchObject({ status: "queued", confidence: 1, post_type: "launch" });
    const t = await env.DB.prepare("SELECT * FROM tools WHERE id = ?").bind(p!.tool_id).first<Record<string, unknown>>();
    expect(t).toMatchObject({
      slug: "patchwork", name: "Patchwork", status: "queued", category: "agent", github_repo: "patchwork-labs/patchwork",
      first_seen_at: "2026-10-05T12:00:00.000Z", last_post_at: "2026-10-05T12:00:00.000Z",
    });
    const { results: aliases } = await env.DB.prepare("SELECT kind, value FROM tool_aliases ORDER BY kind").all();
    expect(aliases).toEqual([
      { kind: "domain", value: "patchwork.dev" },
      { kind: "name", value: "patchwork" },
      { kind: "repo", value: "patchwork-labs/patchwork" },
    ]);

    // The prompt carries the post, the extracted text and the category enum.
    const request = ai.calls[0] as { messages: { content: string }[]; response_format: { json_schema: { properties: { category: { enum: string[] } } } } };
    expect(request.messages.at(-1)!.content).toContain("Patchwork reviews pull requests");
    expect(request.response_format.json_schema.properties.category.enum).toEqual(["agent", "agent-addon", "agent-tools", "agent-security", "review-testing", "memory-context", "ide", "cli", "mcp-dev", "mcp-general", "other"]);
    // Settings from migration 0005: the reasoning model runs with low effort.
    expect((request as unknown as { reasoning_effort: string }).reasoning_effort).toBe("low");
  });

  // GitHub's answer for the repo (only asked for when the post would publish).
  const REPO_URL = "https://api.github.com/repos/patchwork-labs/patchwork";
  const github = (res: () => Response) => fakeFetch((url) => (url === REPO_URL ? res() : undefined));
  const stars = (n: number) => github(() => json({ stargazers_count: n, forks_count: 2, language: "TypeScript", license: { spdx_id: "MIT" } }));
  const toolStatus = async (id: number) =>
    (await env.DB.prepare("SELECT t.status FROM tools t JOIN posts p ON p.tool_id = t.id WHERE p.id = ?").bind(id).first<{ status: string }>())!.status;

  it("publishes at or above the threshold and publishes the tool, keeping the stars as a snapshot", async () => {
    await setThreshold(0.8);
    const id = await insertPost();
    await runClassifyJob({ kind: "classify", post_id: id }, makeDeps({ ai: fakeAi(tool()), fetch: stars(10) }));
    expect((await post(id))!.status).toBe("published");
    expect(await toolStatus(id)).toBe("published");
    const snap = await env.DB.prepare("SELECT stars, forks, language, license FROM repo_snapshots WHERE tool_id = ?").bind((await post(id))!.tool_id).first();
    expect(snap).toEqual({ stars: 10, forks: 2, language: "TypeScript", license: "MIT" });
  });

  it("queues a confident post whose repo is under github_min_stars, whatever the source", async () => {
    await setThreshold(0.8);
    const id = await insertPost(); // an HN post
    await runClassifyJob({ kind: "classify", post_id: id }, makeDeps({ ai: fakeAi(tool()), fetch: stars(9) }));
    expect((await post(id))!.status).toBe("queued");
    expect(await toolStatus(id)).toBe("queued");
  });

  it("reads the floor from settings", async () => {
    await setThreshold(0.8);
    await env.DB.prepare("UPDATE settings SET value = '50' WHERE key = 'github_min_stars'").run();
    const under = await insertPost();
    await runClassifyJob({ kind: "classify", post_id: under }, makeDeps({ ai: fakeAi(tool()), fetch: stars(49) }));
    expect((await post(under))!.status).toBe("queued");
    const over = await insertPost();
    await runClassifyJob({ kind: "classify", post_id: over }, makeDeps({ ai: fakeAi(tool()), fetch: stars(50) }));
    expect((await post(over))!.status).toBe("published");
  });

  it("holds only the post when its tool is already published", async () => {
    await setThreshold(0.8);
    const first = await insertPost();
    await runClassifyJob({ kind: "classify", post_id: first }, makeDeps({ ai: fakeAi(tool()), fetch: stars(12) }));
    const later = await insertPost(); // the repo lost stars since
    await runClassifyJob({ kind: "classify", post_id: later }, makeDeps({ ai: fakeAi(tool()), fetch: stars(9) }));
    expect((await post(later))!.status).toBe("queued");
    expect(await toolStatus(later)).toBe("published");
    expect((await post(first))!.status).toBe("published");
  });

  it("queues the post when GitHub can't find the repo", async () => {
    await setThreshold(0.8);
    const id = await insertPost();
    await runClassifyJob({ kind: "classify", post_id: id }, makeDeps({ ai: fakeAi(tool()), fetch: github(() => new Response("", { status: 404 })) }));
    expect((await post(id))!.status).toBe("queued");
  });

  it("throws on a rate limit, server error, network error or malformed answer, so the queue retries the post", async () => {
    await setThreshold(0.8);
    const failures: [string, () => Response][] = [
      ["rate limit", () => new Response("", { status: 403 })],
      ["too many requests", () => new Response("", { status: 429 })],
      ["server error", () => new Response("", { status: 502 })],
      ["network error", () => {
        throw new TypeError("fetch failed");
      }],
      ["no stargazers_count", () => json({ message: "Moved" })],
    ];
    for (const [name, res] of failures) {
      const id = await insertPost();
      await expect(runClassifyJob({ kind: "classify", post_id: id }, makeDeps({ ai: fakeAi(tool()), fetch: github(res) })), name).rejects.toThrow();
      // Still pending, with the classification stored: the retry reuses it instead of calling the model.
      expect(await post(id), name).toMatchObject({ status: "pending", confidence: 0.92 });
      await runClassifyJob({ kind: "classify", post_id: id }, makeDeps({ fetch: stars(10) }));
      expect((await post(id))!.status, name).toBe("published");
    }
  });

  it("skips the check for tools without a repo", async () => {
    await setThreshold(0.8);
    const id = await insertPost();
    const noCalls = fakeFetch();
    const ai = fakeAi(tool({ tool_name: "Closedly", homepage_url: "https://closedly.ai", github_repo: null, is_open_source: false }));
    await runClassifyJob({ kind: "classify", post_id: id }, makeDeps({ ai, fetch: noCalls }));
    expect((await post(id))!.status).toBe("published");
    expect(noCalls.calls).toEqual([]);
  });

  it("always queues category other, and below-threshold posts", async () => {
    await setThreshold(0.8);
    const other = await insertPost();
    await runClassifyJob({ kind: "classify", post_id: other }, makeDeps({ ai: fakeAi(tool({ category: "other" })) }));
    expect((await post(other))!.status).toBe("queued");

    const low = await insertPost();
    await runClassifyJob({ kind: "classify", post_id: low }, makeDeps({ ai: fakeAi(tool({ confidence: 0.5 })) }));
    expect((await post(low))!.status).toBe("queued");
  });

  it("drops non-tools and roundups with a reason", async () => {
    const news = await insertPost();
    await runClassifyJob({ kind: "classify", post_id: news }, makeDeps({ ai: fakeAi(tool({ is_ai_dev_tool: false, post_type: "news" })) }));
    expect(await post(news)).toMatchObject({ status: "dropped", drop_reason: "not_ai_dev_tool", tool_id: null });

    const roundup = await insertPost();
    await runClassifyJob({ kind: "classify", post_id: roundup }, makeDeps({ ai: fakeAi(tool({ post_type: "roundup" })) }));
    expect(await post(roundup)).toMatchObject({ status: "dropped", drop_reason: "roundup" });
  });

  it("drops a post the model calls a tool but cannot name", async () => {
    const id = await insertPost({ title: "AI: LLMs, Agents, Work, and Us – Engineers. Personal Thoughts" });
    const ai = fakeAi(tool({ tool_name: "", github_repo: null, homepage_url: null, post_type: "discussion" }));
    await runClassifyJob({ kind: "classify", post_id: id }, makeDeps({ ai }));
    expect(await post(id)).toMatchObject({ status: "dropped", drop_reason: "no_tool_named", tool_id: null });
  });

  it("gives tools with long names unique slugs", async () => {
    const name = "An Extremely Long Tool Name That Goes On And On Past Sixty Characters Easily";
    const a = await insertPost();
    await runClassifyJob({ kind: "classify", post_id: a }, makeDeps({ ai: fakeAi(tool({ tool_name: name, github_repo: "a/one", homepage_url: null })) }));
    const b = await insertPost();
    await runClassifyJob({ kind: "classify", post_id: b }, makeDeps({ ai: fakeAi(tool({ tool_name: `${name} For Enterprise Teams, Second Edition`, github_repo: "b/two", homepage_url: null })) }));
    const { results } = await env.DB.prepare("SELECT slug FROM tools ORDER BY id").all<{ slug: string }>();
    expect(results.map((r) => r.slug)).toEqual([
      "an-extremely-long-tool-name-that-goes-on-and-on-past-sixty-c",
      "an-extremely-long-tool-name-that-goes-on-and-on-past-sixty-c-2",
    ]);
  });

  it("retries an invalid response once, then queues it with the raw output", async () => {
    const id = await insertPost();
    const ai = fakeAi("not json", { ...tool(), category: "sdk" });
    await runClassifyJob({ kind: "classify", post_id: id }, makeDeps({ ai }));
    expect(ai.calls).toHaveLength(2);
    const p = await post(id);
    expect(p).toMatchObject({ status: "queued", tool_id: null, classification: null });
    expect(JSON.parse(p!.raw_output as string).error).toContain("category");
  });

  it("succeeds on the retry when the first response is invalid", async () => {
    const id = await insertPost();
    const ai = fakeAi("{", tool());
    await runClassifyJob({ kind: "classify", post_id: id }, makeDeps({ ai }));
    expect((await post(id))!.status).toBe("queued");
    expect((await post(id))!.tool_id).not.toBeNull();
  });

  it("resolves later posts to the same tool by repo, domain or fuzzy name", async () => {
    const first = await insertPost();
    await runClassifyJob({ kind: "classify", post_id: first }, makeDeps({ ai: fakeAi(tool()) }));
    const toolId = (await post(first))!.tool_id;

    const byRepo = await insertPost({ posted_at: "2026-10-06T12:00:00.000Z" });
    await runClassifyJob(
      { kind: "classify", post_id: byRepo },
      makeDeps({ ai: fakeAi(tool({ tool_name: "Something Else", homepage_url: null, post_type: "release", version: "1.1" })) }),
    );
    expect((await post(byRepo))!.tool_id).toBe(toolId);

    const byDomain = await insertPost();
    await runClassifyJob(
      { kind: "classify", post_id: byDomain },
      makeDeps({ ai: fakeAi(tool({ tool_name: "Other", github_repo: null, homepage_url: "https://www.patchwork.dev/docs" })) }),
    );
    expect((await post(byDomain))!.tool_id).toBe(toolId);

    const byName = await insertPost();
    await runClassifyJob(
      { kind: "classify", post_id: byName },
      makeDeps({ ai: fakeAi(tool({ tool_name: "Patchworks AI", github_repo: null, homepage_url: null })) }),
    );
    expect((await post(byName))!.tool_id).toBe(toolId);

    const t = await env.DB.prepare("SELECT last_post_at, (SELECT count(*) FROM tools) AS n FROM tools WHERE id = ?")
      .bind(toolId)
      .first<{ last_post_at: string; n: number }>();
    expect(t).toEqual({ last_post_at: "2026-10-06T12:00:00.000Z", n: 1 });
  });

  it("creates a separate tool with a unique slug when nothing matches", async () => {
    const a = await insertPost();
    await runClassifyJob({ kind: "classify", post_id: a }, makeDeps({ ai: fakeAi(tool()) }));
    const b = await insertPost();
    await runClassifyJob(
      { kind: "classify", post_id: b },
      makeDeps({ ai: fakeAi(tool({ tool_name: "Patchwork!", github_repo: "someone/else", homepage_url: "https://other.dev", description: "" })) }),
    );
    // "patchwork" normalizes the same, so this merges by name; a truly new name gets its own tool:
    const c = await insertPost();
    await runClassifyJob(
      { kind: "classify", post_id: c },
      makeDeps({ ai: fakeAi(tool({ tool_name: "Lintbot", github_repo: null, homepage_url: null })) }),
    );
    const { results } = await env.DB.prepare("SELECT slug FROM tools ORDER BY id").all<{ slug: string }>();
    expect(results.map((r) => r.slug)).toEqual(["patchwork", "lintbot"]);
  });

  it("reuses the classification of a post with the same canonical URL without calling the model", async () => {
    const url = "https://github.com/patchwork-labs/patchwork";
    const first = await insertPost({ url });
    await runClassifyJob({ kind: "classify", post_id: first }, makeDeps({ ai: fakeAi(tool()) }));
    const second = await insertPost({ url });
    await runClassifyJob({ kind: "classify", post_id: second }, makeDeps()); // makeDeps' default AI throws
    expect((await post(second))!.tool_id).toBe((await post(first))!.tool_id);
  });

  it("does not reuse a same-URL result from a different model (e.g. after a model change)", async () => {
    const url = "https://github.com/patchwork-labs/patchwork";
    const first = await insertPost({ url });
    await runClassifyJob({ kind: "classify", post_id: first }, makeDeps({ ai: fakeAi(tool()) }));
    expect(JSON.parse((await post(first))!.classification as string).model).toBe("@cf/zai-org/glm-5.3-flash");
    await env.DB.prepare("UPDATE settings SET value = '\"@cf/other/model\"' WHERE key = 'model_id'").run();
    const second = await insertPost({ url });
    const ai = fakeAi(tool({ post_type: "discussion" }));
    await runClassifyJob({ kind: "classify", post_id: second }, makeDeps({ ai }));
    expect(ai.calls).toHaveLength(1);
    expect((await post(second))!.post_type).toBe("discussion");
    await env.DB.prepare("UPDATE settings SET value = '\"@cf/zai-org/glm-5.3-flash\"' WHERE key = 'model_id'").run();
  });

  it("re-runs the model for forced jobs, and after a prompt or category change", async () => {
    const url = "https://github.com/patchwork-labs/patchwork";
    const first = await insertPost({ url });
    await runClassifyJob({ kind: "classify", post_id: first }, makeDeps({ ai: fakeAi(tool()) }));

    const forced = await insertPost({ url });
    const ai = fakeAi(tool({ post_type: "discussion" }));
    await runClassifyJob({ kind: "classify", post_id: forced, force: true }, makeDeps({ ai }));
    expect(ai.calls).toHaveLength(1);

    const before = await env.DB.prepare("SELECT value FROM settings WHERE key = 'categories'").first<{ value: string }>();
    await env.DB.prepare(`UPDATE settings SET value = '["agent","cli","other"]' WHERE key = 'categories'`).run();
    const afterChange = await insertPost({ url });
    const ai2 = fakeAi(tool({ category: "cli" }));
    await runClassifyJob({ kind: "classify", post_id: afterChange }, makeDeps({ ai: ai2 }));
    expect(ai2.calls).toHaveLength(1);
    await env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'categories'").bind(before!.value).run();
  });

  it("classifies a release link on its own even though it shares the repo's canonical URL", async () => {
    const launch = await insertPost({ url: "https://github.com/patchwork-labs/patchwork" });
    await runClassifyJob({ kind: "classify", post_id: launch }, makeDeps({ ai: fakeAi(tool()) }));

    const releaseUrl = "https://github.com/patchwork-labs/patchwork/releases/tag/v1.1";
    const row = await env.DB.prepare(
      "INSERT INTO posts (source, external_id, url, canonical_url, title, posted_at) VALUES ('lobsters', 'rel', ?, 'https://github.com/patchwork-labs/patchwork', 'Patchwork 1.1', '2026-10-06T00:00:00.000Z') RETURNING id",
    )
      .bind(releaseUrl)
      .first<{ id: number }>();
    await env.ARTICLES.put(articleKey(row!.id), "Patchwork 1.1 release notes");
    const ai = fakeAi(tool({ post_type: "release", version: "1.1" }));
    await runClassifyJob({ kind: "classify", post_id: row!.id }, makeDeps({ ai }));

    expect(ai.calls).toHaveLength(1);
    const release = await post(row!.id);
    expect(release).toMatchObject({ post_type: "release", tool_id: (await post(launch))!.tool_id });
    expect(JSON.parse(release!.classification as string).version).toBe("1.1");
  });

  it("never stores a non-http homepage on a tool", async () => {
    const id = await insertPost();
    await runClassifyJob(
      { kind: "classify", post_id: id },
      makeDeps({ ai: fakeAi(tool({ homepage_url: "javascript:alert(document.cookie)" })) }),
    );
    const t = await env.DB.prepare("SELECT homepage_url FROM tools WHERE id = ?").bind((await post(id))!.tool_id).first();
    expect(t).toEqual({ homepage_url: null });
  });

  it("ignores posts that were already routed", async () => {
    const id = await insertPost();
    await runClassifyJob({ kind: "classify", post_id: id }, makeDeps({ ai: fakeAi(tool()) }));
    await runClassifyJob({ kind: "classify", post_id: id }, makeDeps());
    expect((await post(id))!.status).toBe("queued");
  });
});
