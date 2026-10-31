import { z } from "zod";
import { normalizeGithubRepo, parseUrl } from "./urls.ts";

export const POST_TYPES = ["launch", "release", "discussion", "roundup", "news"] as const;

const nullableString = z
  .string()
  .nullable()
  .transform((v) => (v && v.trim() && v.trim().toLowerCase() !== "null" ? v.trim() : null));

/** "example.dev" -> "https://example.dev/"; anything that is not an http(s) URL -> null. */
export function normalizeHomepage(value: string | null): string | null {
  if (!value) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  return parseUrl(withScheme)?.href ?? null;
}

const MAX_TAGS = 6;
const MAX_SUGGESTED_TAGS = 3;
const unique = (values: string[]) => [...new Set(values)];

/**
 * zod schema for the model's JSON. `categories` and the tag vocabulary come from the
 * settings table. With a vocabulary, tags outside it move to `suggested_tags` (so an
 * older classification or a stray tag never fails validation); without one, tags are
 * left as they are.
 */
export function classificationSchema(categories: readonly string[], tagVocabulary?: readonly string[]) {
  return z
    .object({
    // The model's one-line rationale; shown to reviewers. Optional so older outputs still parse.
    reason: z.string().trim().max(400).optional(),
    // Set by the ingest Worker (not the model): which model produced this classification.
    model: z.string().optional(),
    // Set by the ingest Worker: fingerprint of model, reasoning effort, prompt and categories.
    classifier: z.string().optional(),
    is_ai_dev_tool: z.boolean(),
    post_type: z.enum(POST_TYPES),
    tool_name: z.string().transform((v) => v.trim()),
    homepage_url: nullableString.transform(normalizeHomepage),
    github_repo: nullableString.transform((v) => normalizeGithubRepo(v)),
    version: nullableString,
    category: z.string().refine((v) => categories.includes(v), { message: "category not in settings" }),
    tags: z.array(z.string().trim().toLowerCase().min(1)).max(10),
    // Tags the model thinks are missing from the vocabulary; reviewed on Admin → Tags & categories.
    suggested_tags: z.array(z.string().trim().toLowerCase().min(1)).max(10).optional(),
    is_open_source: z.boolean(),
    description: z.string().transform((v) => v.trim().slice(0, 140)),
    confidence: z.number().min(0).max(1),
    })
    .transform((c) => {
      if (!tagVocabulary) return c;
      const known = unique(c.tags.filter((t) => tagVocabulary.includes(t))).slice(0, MAX_TAGS);
      const unknown = [...(c.suggested_tags ?? []), ...c.tags.filter((t) => !tagVocabulary.includes(t))];
      const suggested = unique(unknown.filter((t) => !tagVocabulary.includes(t))).slice(0, MAX_SUGGESTED_TAGS);
      return { ...c, tags: known, suggested_tags: suggested };
    });
}
export type Classification = z.output<ReturnType<typeof classificationSchema>>;

/** JSON Schema passed to Workers AI JSON mode. Kept by hand to match classificationSchema(). */
export function classificationJsonSchema(categories: readonly string[], tagVocabulary: readonly string[]) {
  const nullable = { type: ["string", "null"] };
  return {
    type: "object",
    // "reason" comes first so the model states what the post is before deciding.
    properties: {
      reason: { type: "string" },
      is_ai_dev_tool: { type: "boolean" },
      post_type: { type: "string", enum: [...POST_TYPES] },
      tool_name: { type: "string" },
      homepage_url: nullable,
      github_repo: nullable,
      version: nullable,
      category: { type: "string", enum: [...categories] },
      tags: { type: "array", items: { type: "string", enum: [...tagVocabulary] } },
      suggested_tags: { type: "array", items: { type: "string" } },
      is_open_source: { type: "boolean" },
      description: { type: "string" },
      confidence: { type: "number" },
    },
    required: [
      "reason", "is_ai_dev_tool", "post_type", "tool_name", "homepage_url", "github_repo", "version",
      "category", "tags", "suggested_tags", "is_open_source", "description", "confidence",
    ],
  };
}
