import { describe, expect, it } from "vitest";
import { classifyPost, modelText, systemPrompt } from "../src/classifier.ts";

const valid = {
  reason: "A CLI coding agent.", is_ai_dev_tool: true, post_type: "launch", tool_name: "Patchwork", homepage_url: null,
  github_repo: null, version: null, category: "cli", tags: [], is_open_source: true, description: "d", confidence: 0.9,
};
const TAGS = [
  { slug: "works-with", label: "Works with", hint: "the agent it plugs into", tags: [{ slug: "claude-code", label: "Claude Code" }, { slug: "codex", label: "Codex" }] },
  { slug: "platform", label: "Platform", hint: "", tags: [{ slug: "macos", label: "macOS" }] },
];
const input = {
  model: "@cf/x/y", categories: ["agent", "ide", "cli", "mcp-dev", "mcp-general", "other"], tags: TAGS,
  categoryInfo: { cli: { label: "CLI", hue: "amber" as const, hint: "AI command-line tools", blurb: "" } },
  post: { source: "hn", title: "t", url: "u" }, text: "", fewShot: [],
};

describe("systemPrompt", () => {
  it("describes each category from category_info, and lists one without an entry bare", () => {
    const prompt = systemPrompt(input.categories, input.categoryInfo, TAGS);
    expect(prompt).toContain("  - cli: AI command-line tools\n");
    expect(prompt).toContain("  - ide\n");
  });
});

describe("modelText", () => {
  it("reads the classic and the OpenAI-style result shapes", () => {
    expect(modelText({ response: { a: 1 } })).toEqual({ a: 1 });
    expect(modelText({ response: '{"a":1}' })).toBe('{"a":1}');
    expect(modelText({ choices: [{ message: { content: '{"a":1}' } }] })).toBe('{"a":1}');
    expect(modelText(null)).toBeNull();
  });
});

describe("classifyPost", () => {
  it("parses an OpenAI-style response and keeps the model's reason", async () => {
    const r = await classifyPost(input, async () => ({ choices: [{ message: { content: JSON.stringify(valid) } }] }));
    expect(r.ok && r.value.reason).toBe("A CLI coding agent.");
  });

  it("sends reasoning_effort only when set", async () => {
    const seen: Record<string, unknown>[] = [];
    const ai = async (_m: string, req: Record<string, unknown>) => (seen.push(req), { response: valid });
    await classifyPost(input, ai);
    await classifyPost({ ...input, reasoningEffort: "low" }, ai);
    expect("reasoning_effort" in seen[0]!).toBe(false);
    expect(seen[1]!.reasoning_effort).toBe("low");
  });
});

describe("tag vocabulary", () => {
  it("lists the tag groups in the prompt and the JSON schema", async () => {
    const calls: Record<string, unknown>[] = [];
    const ai = async (_m: string, req: Record<string, unknown>) => (calls.push(req), { response: JSON.stringify(valid) });
    await classifyPost(input, ai);
    const req = calls[0] as { messages: { content: string }[]; response_format: { json_schema: { properties: Record<string, { items: { enum?: string[] } }> } } };
    expect(req.messages[0]!.content).toContain("Works with (the agent it plugs into): claude-code (Claude Code), codex\n");
    expect(req.messages[0]!.content).toContain("Platform: macos\n");
    expect(req.response_format.json_schema.properties.tags!.items.enum).toEqual(["claude-code", "codex", "macos"]);
  });

  it("keeps vocabulary tags and moves the rest to suggested_tags", async () => {
    const out = { ...valid, tags: ["Claude-Code", "python", "macos", "claude-code"], suggested_tags: ["kiro"] };
    const r = await classifyPost(input, async () => ({ response: JSON.stringify(out) }));
    expect(r.ok && r.value.tags).toEqual(["claude-code", "macos"]);
    expect(r.ok && r.value.suggested_tags).toEqual(["kiro", "python"]);
  });
});
