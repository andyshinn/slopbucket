import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { articleKey } from "../src/content.ts";
import { LANGUAGE_BATCH, runLanguagesJob } from "../src/languages-job.ts";
import { makeDeps, resetDb } from "./helpers.ts";

beforeEach(resetDb);

let n = 0;
async function insert(title: string, status: string, over: { text?: string; language?: string } = {}): Promise<number> {
  n++;
  const row = await env.DB.prepare(
    "INSERT INTO posts (source, external_id, url, canonical_url, title, posted_at, status, language) VALUES ('github', ?, ?, ?, ?, '2026-10-01T00:00:00.000Z', ?, ?) RETURNING id",
  )
    .bind(`l${n}`, `https://x.dev/${n}`, `https://x.dev/${n}`, title, status, over.language ?? null)
    .first<{ id: number }>();
  if (over.text) await env.ARTICLES.put(articleKey(row!.id), over.text);
  return row!.id;
}
const language = (id: number) => env.DB.prepare("SELECT language FROM posts WHERE id = ?").bind(id).first<{ language: string | null }>().then((r) => r?.language);

it("fills missing languages of queued and published posts from cached text, without the model or the web", async () => {
  const zh = await insert("acme/agent", "queued", { text: "一个在终端里运行的编码代理，可以读取仓库并提出修改建议。" });
  const en = await insert("acme/patchwork", "published", { text: "Patchwork reviews your pull requests with an agent." });
  const titleOnly = await insert("Show HN: an agent for the terminal", "queued");
  const unknown = await insert("acme/x", "queued");
  const kept = await insert("acme/kept", "queued", { text: "Ein Werkzeug für die Kommandozeile und mit Agenten.", language: "en" });
  const dropped = await insert("acme/dropped", "dropped", { text: "Patchwork reviews your pull requests with an agent." });

  const deps = makeDeps(); // its AI and fetch throw if called
  expect(await runLanguagesJob({ kind: "languages" }, deps)).toBe(4);
  expect(await language(zh)).toBe("zh");
  expect(await language(en)).toBe("en");
  expect(await language(titleOnly)).toBe("en");
  expect(await language(unknown)).toBe("und");
  expect(await language(kept)).toBe("en");
  expect(await language(dropped)).toBeNull();
  expect(deps.fetchSent).toEqual([]);
  // Nothing left: a second run does nothing.
  expect(await runLanguagesJob({ kind: "languages" }, deps)).toBe(0);
});

it("re-enqueues itself while a full batch came back", async () => {
  const values = Array.from({ length: LANGUAGE_BATCH + 1 }, (_, i) => `('github', 'b${i}', 'https://x.dev', 'https://x.dev', 'acme/x', '2026-10-01T00:00:00.000Z', 'queued')`);
  for (let i = 0; i < values.length; i += 50) {
    await env.DB.prepare(`INSERT INTO posts (source, external_id, url, canonical_url, title, posted_at, status) VALUES ${values.slice(i, i + 50).join(", ")}`).run();
  }
  const deps = makeDeps();
  expect(await runLanguagesJob({ kind: "languages" }, deps)).toBe(LANGUAGE_BATCH);
  expect(deps.fetchSent).toEqual([{ kind: "languages" }]);
  expect(await runLanguagesJob({ kind: "languages" }, deps)).toBe(1);
  expect(deps.fetchSent).toHaveLength(1);
});
