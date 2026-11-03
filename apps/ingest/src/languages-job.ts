import { type LanguagesJob, postLanguage } from "@slop-bucket/core";
import { articleKey } from "./content.ts";
import type { Deps } from "./deps.ts";

/** Posts per message; the job re-enqueues itself until none are left. */
export const LANGUAGE_BATCH = 200;
/** R2 reads in flight at once. */
const READ_CONCURRENCY = 25;

/**
 * Fills posts.language for queued and published posts that don't have one yet
 * (classified before language detection existed), from the title and the text
 * cached in R2. No model calls and nothing is fetched from the web: a post with
 * no cached text is judged by its title. Every post it reads gets a language
 * (`und` at worst), so each batch makes progress.
 */
export async function runLanguagesJob(_job: LanguagesJob, deps: Deps): Promise<number> {
  const { db } = deps;
  const { results } = await db
    .prepare("SELECT id, title FROM posts WHERE language IS NULL AND status IN ('queued', 'published') ORDER BY id LIMIT ?")
    .bind(LANGUAGE_BATCH)
    .all<{ id: number; title: string }>();
  const updates: D1PreparedStatement[] = [];
  for (let i = 0; i < results.length; i += READ_CONCURRENCY) {
    const chunk = results.slice(i, i + READ_CONCURRENCY);
    const texts = await Promise.all(chunk.map(async (p) => (await deps.articles.get(articleKey(p.id)))?.text() ?? null));
    chunk.forEach((p, j) => {
      updates.push(db.prepare("UPDATE posts SET language = ? WHERE id = ?").bind(postLanguage(p.title, texts[j] ?? null), p.id));
    });
  }
  if (updates.length) await db.batch(updates);
  // Sent after the batch commits. If sending fails, the queue retries this message,
  // which picks up the next 200; if its retries run out, the chain stops until the
  // daily cron starts it again. Two jobs running at once (cron and Status) may read
  // the same rows; the writes are idempotent.
  const more = results.length === LANGUAGE_BATCH;
  if (more) await deps.fetchQueue.send({ kind: "languages" } satisfies LanguagesJob);
  console.log(JSON.stringify({ event: "languages", detected: results.length, more }));
  return results.length;
}
