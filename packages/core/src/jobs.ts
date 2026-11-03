import { z } from "zod";

// Reddit was dropped (new API apps need manual approval). Product Hunt has no adapter until API access is granted.
export const SOURCES = ["hn", "lobsters", "github", "producthunt"] as const;
export const sourceSchema = z.enum(SOURCES);
export type Source = z.infer<typeof sourceSchema>;

// Message body on the fetch queue: one job per source. The daily cron sends
// mode "daily"; ops.yml sends "manual" (trigger one source) or "backfill".
export const fetchJobSchema = z.object({
  kind: z.literal("fetch"),
  source: sourceSchema,
  mode: z.enum(["daily", "manual", "backfill"]),
  since: z.iso.datetime().optional(),
  until: z.iso.datetime().optional(),
});
export type FetchJob = z.infer<typeof fetchJobSchema>;

// Also on the fetch queue: the daily trending update (engagement refresh, GitHub
// stats, trending scores). The 07:00 cron sends "daily"; the status panel "manual".
export const trendingJobSchema = z.object({
  kind: z.literal("trending"),
  mode: z.enum(["daily", "manual"]),
});
export type TrendingJob = z.infer<typeof trendingJobSchema>;

// Message body on the classify queue: one post per message.
export const classifyJobSchema = z.object({
  kind: z.literal("classify"),
  post_id: z.number().int().positive(),
  // Always call the model: skip reusing a duplicate URL's result (set by re-classify).
  force: z.boolean().optional(),
});
export type ClassifyJob = z.infer<typeof classifyJobSchema>;

// Also on the fetch queue: fills posts.language for queued and published posts
// that don't have one yet, from the title and the text cached in R2 (no model
// calls, nothing re-fetched). It works in batches and re-enqueues itself until
// none are left. The daily cron sends one; Status → Jobs and ops.yml can too.
export const languagesJobSchema = z.object({
  kind: z.literal("languages"),
});
export type LanguagesJob = z.infer<typeof languagesJobSchema>;
