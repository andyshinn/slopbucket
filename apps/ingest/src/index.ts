import {
  type FetchJob, type LanguagesJob, type TrendingJob, classifyJobSchema, fetchJobSchema, languagesJobSchema, trendingJobSchema,
} from "@slop-bucket/core";
import { requeueStalePending, runClassifyJob } from "./classify-job.ts";
import { depsFromEnv } from "./deps.ts";
import { runFetchJob } from "./fetch-job.ts";
import { runLanguagesJob } from "./languages-job.ts";
import { runTrendingJob } from "./trending-job.ts";
import { ADAPTERS } from "./sources/index.ts";

export const FETCH_QUEUE = "sb-fetch";
export const CLASSIFY_QUEUE = "sb-classify";
/** An hour after the daily fetch, so most new posts are stored and classified. */
export const TRENDING_CRON = "0 7 * * *";

export default {
  // Daily run: one fetch job per source that has an adapter, a retry of posts
  // left pending (e.g. while the AI spend limit was blocking calls), and a
  // languages job for any post still without a detected language.
  async scheduled(controller, env, _ctx) {
    if (controller.cron === TRENDING_CRON) {
      const job: TrendingJob = { kind: "trending", mode: "daily" };
      await env.FETCH_QUEUE.send(job);
      console.log(JSON.stringify({ event: "cron", job: "trending" }));
      return;
    }
    const until = new Date(controller.scheduledTime).toISOString();
    const jobs: FetchJob[] = Object.keys(ADAPTERS).map((source) => ({
      kind: "fetch",
      source: source as FetchJob["source"],
      mode: "daily",
      until,
    }));
    const languages: LanguagesJob = { kind: "languages" };
    await env.FETCH_QUEUE.sendBatch([...jobs, languages].map((body) => ({ body })));
    const requeued = await requeueStalePending(env.DB, env.CLASSIFY_QUEUE);
    console.log(JSON.stringify({ event: "cron", sources: jobs.map((j) => j.source), requeued }));
  },

  async queue(batch, env, _ctx) {
    const deps = depsFromEnv(env);
    for (const message of batch.messages) {
      try {
        if (batch.queue === FETCH_QUEUE) {
          const trending = trendingJobSchema.safeParse(message.body);
          const job = fetchJobSchema.safeParse(message.body);
          const languages = languagesJobSchema.safeParse(message.body);
          if (trending.success) await runTrendingJob(trending.data, deps);
          else if (languages.success) await runLanguagesJob(languages.data, deps);
          else if (job.success) await runFetchJob(job.data, deps);
          else console.error(JSON.stringify({ event: "bad_message", queue: batch.queue, body: message.body }));
        } else if (batch.queue === CLASSIFY_QUEUE) {
          const job = classifyJobSchema.safeParse(message.body);
          if (job.success) await runClassifyJob(job.data, deps);
          else console.error(JSON.stringify({ event: "bad_message", queue: batch.queue, body: message.body }));
        }
        message.ack();
      } catch (err) {
        console.error(JSON.stringify({ event: "job_failed", queue: batch.queue, body: message.body, attempts: message.attempts, error: String(err) }));
        message.retry({ delaySeconds: 60 * message.attempts });
      }
    }
  },
} satisfies ExportedHandler<Env>;
