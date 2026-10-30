import { env } from "cloudflare:workers";
import type { Deps, Fetcher, RunModel } from "../src/deps.ts";

export interface FakeQueue {
  queue: Queue;
  sent: unknown[];
}

export function fakeQueue(): FakeQueue {
  const sent: unknown[] = [];
  const queue = {
    async send(body: unknown) {
      sent.push(body);
    },
    async sendBatch(messages: Iterable<{ body: unknown }>) {
      for (const m of messages) sent.push(m.body);
    },
  } as unknown as Queue;
  return { queue, sent };
}

type Route = (url: string) => Response | undefined;

/** Fetch that answers from recorded fixtures; any unmatched URL fails the test. */
export function fakeFetch(...routes: Route[]): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  const fn = async (input: string) => {
    calls.push(input);
    for (const route of routes) {
      const res = route(input);
      if (res) return res;
    }
    throw new Error(`unexpected fetch: ${input}`);
  };
  return Object.assign(fn, { calls });
}

export const json = (body: unknown) => Response.json(body);

export function makeDeps(over: Partial<Deps> = {}): Deps & { fetchSent: unknown[]; classifySent: unknown[] } {
  const fetchQ = fakeQueue();
  const classifyQ = fakeQueue();
  return {
    db: env.DB,
    articles: env.ARTICLES,
    fetchQueue: fetchQ.queue,
    classifyQueue: classifyQ.queue,
    ai: async () => {
      throw new Error("unexpected AI call");
    },
    fetch: fakeFetch(),
    sleep: async () => {},
    ...over,
    fetchSent: fetchQ.sent,
    classifySent: classifyQ.sent,
  };
}

/** Fake Workers AI returning the given responses in order. */
export function fakeAi(...responses: unknown[]): RunModel & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const fn = async (_model: string, input: Record<string, unknown>) => {
    calls.push(input);
    if (calls.length > responses.length) throw new Error("too many AI calls");
    return { response: responses[calls.length - 1] };
  };
  return Object.assign(fn, { calls });
}

export async function resetDb(): Promise<void> {
  await env.DB.batch(
    ["review_decisions", "post_snapshots", "repo_snapshots", "tool_aliases", "posts", "tool_merges", "tools", "source_runs"].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
  await env.DB.batch([
    env.DB.prepare("UPDATE settings SET value = '1' WHERE key = 'review_threshold'"),
    env.DB.prepare("UPDATE settings SET value = '10' WHERE key = 'github_min_stars'"),
  ]);
}
