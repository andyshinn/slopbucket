// Scores the classifier against the hand-labeled set in evals/classifier.
//   pnpm --filter @slop-bucket/ingest eval:classifier -- [--model=@cf/zai-org/glm-5.3-flash] [--reasoning=low] [--limit=40]
// The model and category list default to production's settings (read from D1), so the eval
// matches what the Worker runs; pass --model, --categories=a,b,other or --tags=groups.json
// (the `tags` setting's JSON) to try something else.
// Credentials: CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID, or a local `wrangler login`.
// Calls go through the "sb" AI Gateway, so the daily spend cap applies to evals too.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { categoryInfoSchema, tagGroupsSchema } from "@slop-bucket/core";
import { classifyPost } from "../src/classifier.ts";
import { getArticleText } from "../src/content.ts";
import type { Deps, RunModel } from "../src/deps.ts";

const root = resolve(import.meta.dirname, "../../..");
const { values: args } = parseArgs({
  // pnpm forwards a literal "--" before script arguments.
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    model: { type: "string" },
    categories: { type: "string" },
    tags: { type: "string" },
    reasoning: { type: "string" },
    set: { type: "string", default: "evals/classifier/labeled-2026-10.jsonl" },
    limit: { type: "string" },
    concurrency: { type: "string", default: "4" },
    // Workers Paid models (GLM, DeepSeek) allow 20 requests/minute; others allow 300.
    rpm: { type: "string", default: "18" },
    gateway: { type: "string", default: "sb" },
    out: { type: "string" },
  },
});
const NEURON_USD = 0.011 / 1000;

interface Item { post_id: number; source: string; url: string; title: string; in_scope: boolean; mcp_only: boolean }
let items: Item[] = readFileSync(resolve(root, args.set!), "utf8").trim().split("\n").map((l) => JSON.parse(l));
if (args.limit) items = items.slice(0, Number(args.limit));

const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? "0bddc8c62dd00882bc061416e8be2ce4";
const token =
  process.env.CLOUDFLARE_API_TOKEN ??
  readFileSync(`${homedir()}/Library/Preferences/.wrangler/config/default.toml`, "utf8").match(/oauth_token = "([^"]+)"/)?.[1];
if (!token) throw new Error("Set CLOUDFLARE_API_TOKEN or run `wrangler login`.");

// Production settings, unless overridden on the command line.
async function productionSetting(key: string): Promise<unknown> {
  const config = readFileSync(resolve(root, "apps/ingest/wrangler.jsonc"), "utf8");
  const databaseId = config.match(/"database_id":\s*"([^"]+)"/)?.[1];
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${databaseId}/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ sql: "SELECT value FROM settings WHERE key = ?", params: [key] }),
  });
  const body = (await res.json()) as { result?: { results: { value: string }[] }[] };
  const value = body.result?.[0]?.results[0]?.value;
  if (!res.ok || value === undefined) throw new Error(`Could not read setting ${key} from D1 (${res.status}); pass it as a flag.`);
  return JSON.parse(value);
}
const model = args.model ?? String(await productionSetting("model_id"));
const categories = args.categories ? args.categories.split(",").map((c) => c.trim()) : ((await productionSetting("categories")) as string[]);
const categoryInfo = categoryInfoSchema.parse(await productionSetting("category_info"));
const tags = tagGroupsSchema.parse(args.tags ? JSON.parse(readFileSync(resolve(args.tags), "utf8")) : await productionSetting("tags"));

let neurons = 0;
// Shared pacing across workers: request starts are spaced 60s / rpm apart.
const gap = 60_000 / Number(args.rpm);
let nextSlot = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function pace() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + gap;
  await sleep(wait);
}

const ai: RunModel = async (model, input) => {
  for (let attempt = 1; ; attempt++) {
    await pace();
    const res = await fetch(`https://gateway.ai.cloudflare.com/v1/${account}/${args.gateway}/workers-ai/${model}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "cf-aig-skip-cache": "true" },
      body: JSON.stringify(input),
    });
    const body = (await res.json()) as { result?: { usage?: { neurons?: number } }; errors?: unknown };
    if (res.ok) {
      neurons += body.result?.usage?.neurons ?? 0;
      return body.result;
    }
    // Rate limits are per minute: wait most of a window before retrying.
    const retryable = res.status === 429 || res.status >= 500;
    if (attempt >= 4 || !retryable) throw new Error(`${res.status} ${JSON.stringify(body.errors)}`);
    await sleep(res.status === 429 ? 30_000 * attempt : 2_000 * attempt);
  }
};

// Article text, fetched once with the production extractor and cached locally.
const cacheDir = resolve(root, ".cache/eval-texts");
mkdirSync(cacheDir, { recursive: true });
const deps = { articles: { get: async () => null, put: async () => {} }, fetch: (u: string, i?: RequestInit) => fetch(u, i), githubToken: process.env.GH_TOKEN } as unknown as Deps;
async function text(item: Item): Promise<string> {
  const file = resolve(cacheDir, `${item.post_id}.txt`);
  if (existsSync(file)) return readFileSync(file, "utf8");
  const t = await getArticleText({ id: item.post_id, url: item.url }, deps);
  writeFileSync(file, t);
  return t;
}

// predicted: what production would do. Invalid model output counts as queued (true), as in
// production; an API failure is null (the post would stay pending and be retried).
type Row = Item & {
  predicted: boolean | null;
  invalid?: boolean;
  category?: string;
  tags?: string[];
  suggested_tags?: string[];
  confidence?: number;
  reason?: string;
  error?: string;
  ms: number;
};
const rows: Row[] = [];
let next = 0;
await Promise.all(
  Array.from({ length: Number(args.concurrency) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      const t0 = Date.now();
      try {
        const r = await classifyPost(
          { model, categories, categoryInfo, tags, post: item, text: await text(item), fewShot: [], reasoningEffort: args.reasoning },
          ai,
        );
        const c = r.ok ? r.value : null;
        // Same routing as production: a tool needs a name or repo, roundups are dropped, invalid output is queued.
        const predicted = c ? c.is_ai_dev_tool && c.post_type !== "roundup" && Boolean(c.tool_name || c.github_repo) : true;
        rows.push({ ...item, predicted, invalid: !r.ok, category: c?.category, tags: c?.tags, suggested_tags: c?.suggested_tags, confidence: c?.confidence, reason: c?.reason, error: r.ok ? undefined : r.error, ms: Date.now() - t0 });
      } catch (err) {
        rows.push({ ...item, predicted: null, error: String(err), ms: Date.now() - t0 });
      }
      process.stderr.write(".");
    }
  }),
);
process.stderr.write("\n");

function score(subset: Row[], gold: (r: Row) => boolean) {
  const valid = subset.filter((r) => r.predicted !== null);
  const tp = valid.filter((r) => r.predicted && gold(r)).length;
  const fp = valid.filter((r) => r.predicted && !gold(r)).length;
  const fn = valid.filter((r) => !r.predicted && gold(r)).length;
  const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "n/a");
  const invalid = subset.filter((r) => r.invalid).length;
  return `precision ${pct(tp, tp + fp)}  recall ${pct(tp, tp + fn)}  (tp ${tp}, fp ${fp}, fn ${fn}, invalid output ${invalid}, API failures ${subset.length - valid.length})`;
}
const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
const cost = neurons * NEURON_USD;
console.log(`\ncategories ${categories.join(", ")}`);
console.log(`model ${model}${args.reasoning ? ` (reasoning ${args.reasoning})` : ""} · ${rows.length} posts`);
console.log(`all          ${score(rows, (r) => r.in_scope)}`);
console.log(`strict MCP   ${score(rows, (r) => r.in_scope && !r.mcp_only)}`);
for (const src of [...new Set(rows.map((r) => r.source))]) console.log(`${src.padEnd(12)} ${score(rows.filter((r) => r.source === src), (r) => r.in_scope)}`);
console.log(`cost         $${cost.toFixed(4)} for ${rows.length} posts (~$${((cost * 300) / rows.length).toFixed(2)}/day at 300 posts)`);
console.log(`latency      (incl. pacing) median ${ms[Math.floor(ms.length / 2)]}ms, p90 ${ms[Math.floor(ms.length * 0.9)]}ms`);
const wrong = rows.filter((r) => r.predicted !== null && r.predicted !== r.in_scope);
console.log(`\nmisclassified (${wrong.length}):`);
for (const r of wrong) console.log(`  ${r.predicted ? "FP" : "FN"} [${r.source}] ${r.title.slice(0, 90)}`);
for (const r of rows.filter((r) => r.error)) console.log(`  ${r.invalid ? "INVALID" : "ERR"} [${r.source}] ${r.title.slice(0, 60)}: ${r.error!.slice(0, 120)}`);
if (args.out) writeFileSync(args.out, JSON.stringify(rows, null, 1));
