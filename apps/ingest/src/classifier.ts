import { z } from "zod";
import {
  type CategoryInfo,
  type Classification,
  type TagGroups,
  categoryDisplay,
  classificationJsonSchema,
  classificationSchema,
  tagSlugs,
} from "@slop-bucket/core";
import type { RunModel } from "./deps.ts";

export interface PostInput {
  source: string;
  title: string;
  url: string;
}

export interface FewShotExample {
  post: PostInput;
  output: Record<string, unknown>;
}

export type ClassifyResult =
  | { ok: true; value: Classification; raw: string }
  | { ok: false; raw: string; error: string };

export function systemPrompt(categories: readonly string[], categoryInfo: CategoryInfo, tags: TagGroups): string {
  const categoryLines = categories
    .map((c) => {
      const { hint } = categoryDisplay(c, categoryInfo);
      return `  - ${c}${hint ? `: ${hint}` : ""}`;
    })
    .join("\n");
  const tagLines = tags
    .map((g) => `  - ${g.label}${g.hint ? ` (${g.hint})` : ""}: ${g.tags.map((t) => (t.label.toLowerCase() === t.slug ? t.slug : `${t.slug} (${t.label})`)).join(", ")}`)
    .join("\n");
  return `You classify posts from developer communities for a public directory of AI coding tools.

Decide whether the post is mainly about ONE specific product or project that is an AI coding tool. Set is_ai_dev_tool to true only if all three hold:
1. The post presents or discusses one specific, named tool: a launch, a release, a repository, or a post centered on using that tool. News stories, essays, opinion pieces, tutorials, benchmarks, studies and company announcements do not count, even when they mention AI tools.
2. The tool is for software developers, and its job is writing, reviewing, testing, debugging, running, deploying or managing code.
3. It uses AI to do that job, or it is built specifically to work with AI coding agents: a plugin, skill, hook or extension for Claude Code, Codex, Cursor or similar; or a monitor, orchestrator or session manager for coding agents.

Exception: a post about one specific MCP (Model Context Protocol) server is always in scope, whatever the server is for. Use category "mcp-dev" when it helps with software development and "mcp-general" otherwise. This covers products that are mainly an MCP server. A product built for something else that also offers an MCP interface (an error tracker, a video editor, a smart-home controller) is judged by what it is mainly for.

These are NOT AI coding tools (is_ai_dev_tool = false):
- models, inference engines, training or evaluation projects, benchmarks
- SDKs, frameworks, guardrails, RAG pipelines and other building blocks for LLM apps or general-purpose agents
- general-purpose AI agents and assistants (personal, browser, email, business, shopping) and infrastructure for them (browsers, VMs, gateways)
- agent skills or plugins whose job is not code (video, design, marketing, research, e-commerce)
- apps that were built with AI but do not use it, and developer tools that neither use AI nor target AI coding agents
- AI products for non-developers (notes, writing, chat, analytics, search, media)

When unsure, choose false.

Fields (write "reason" first):
- reason: one short sentence saying what the post is about and who uses the tool for what.
- is_ai_dev_tool: true only if all three conditions above hold, or the post is about one specific MCP server.
- post_type: "launch" (a new tool is announced), "release" (a new version of an existing tool), "discussion" (experience, opinion or question about a tool), "roundup" (comparisons, lists, "awesome-X"), or "news".
- tool_name: the tool's name as its makers write it; "" if there is none.
- homepage_url: the tool's own website, or null. Not a GitHub, blog or news URL.
- github_repo: "owner/repo" if the tool has a GitHub repository, else null.
- version: the version number for releases, else null.
- category: one of:
${categoryLines}
  Choose by what the tool is for, using the most specific category that fits. "other" is only for in-scope tools that fit no other category, never for out-of-scope posts.
- tags: up to 6 tags, chosen only from this list, for facts the content states about the tool (an empty list is fine). Tags describe a tool; they never make a post in scope.
${tagLines}
  When a tool works with any coding agent or any model, use any-agent or any-model instead of listing several.
- suggested_tags: up to 3 tags that are clearly important for this tool but missing from the list above (for example a coding agent that is not listed), lowercase with hyphens. Usually [].
- is_open_source: true if the source code is publicly available under an open license.
- description: one plain, factual line under 140 characters. No marketing language.
- confidence: from 0 to 1, how sure you are about is_ai_dev_tool, post_type and the tool's identity. Use 0.9 or more only when the content states plainly what the tool does and who it is for; 0.5 to 0.8 when you are inferring; below 0.5 when you are guessing.

Reply with the JSON object only.`;
}

export function userPrompt(post: PostInput, text: string): string {
  return `Source: ${post.source}\nTitle: ${post.title}\nURL: ${post.url}\n\nContent:\n${text || "(no content could be fetched)"}`;
}

/**
 * Identifies the classifier setup a result came from: model, reasoning effort, and the
 * system prompt (which embeds the categories with their descriptions, and the tag vocabulary). Few-shot examples are left out on purpose:
 * they change with every review, and would stop duplicate-URL reuse almost entirely.
 */
export async function classifierFingerprint(
  model: string,
  reasoningEffort: string,
  categories: readonly string[],
  categoryInfo: CategoryInfo,
  tags: TagGroups,
): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify([model, reasoningEffort, systemPrompt(categories, categoryInfo, tags)]));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return [...hash.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The model's answer from a Workers AI result. Older models return `{ response }`
 * (a string, or an object in JSON mode); newer ones return the OpenAI shape
 * `{ choices: [{ message: { content } }] }`.
 */
export function modelText(out: unknown): unknown {
  const o = out as { response?: unknown; choices?: { message?: { content?: unknown } }[] } | null;
  return o?.response ?? o?.choices?.[0]?.message?.content ?? null;
}

/** Stage 3: one Workers AI call, validated with zod; an invalid response is retried once. */
export async function classifyPost(
  input: {
    model: string;
    categories: readonly string[];
    categoryInfo: CategoryInfo;
    tags: TagGroups;
    post: PostInput;
    text: string;
    fewShot: FewShotExample[];
    /** For reasoning models: "none" | "low" | "medium" | "high" (supported levels vary by model). */
    reasoningEffort?: string;
  },
  ai: RunModel,
): Promise<ClassifyResult> {
  const messages = [
    { role: "system", content: systemPrompt(input.categories, input.categoryInfo, input.tags) },
    ...input.fewShot.flatMap((ex) => [
      { role: "user", content: userPrompt(ex.post, "(omitted in example)") },
      { role: "assistant", content: JSON.stringify(ex.output) },
    ]),
    { role: "user", content: userPrompt(input.post, input.text) },
  ];
  const vocabulary = tagSlugs(input.tags);
  const schema = classificationSchema(input.categories, vocabulary);
  const request = {
    messages,
    response_format: { type: "json_schema", json_schema: classificationJsonSchema(input.categories, vocabulary) },
    // Reasoning models spend part of this on thinking before the JSON.
    max_tokens: 1500,
    temperature: 0,
    ...(input.reasoningEffort ? { reasoning_effort: input.reasoningEffort } : {}),
  };

  let failure = { raw: "", error: "" };
  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = modelText(await ai(input.model, request));
    const raw = typeof response === "string" ? response : JSON.stringify(response ?? null);
    let parsed: unknown;
    try {
      parsed = typeof response === "string" ? JSON.parse(response) : response;
    } catch {
      failure = { raw, error: "response is not valid JSON" };
      continue;
    }
    const result = schema.safeParse(parsed);
    if (result.success) return { ok: true, value: result.data, raw };
    failure = { raw, error: z.prettifyError(result.error) };
  }
  return { ok: false, ...failure };
}
