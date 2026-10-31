import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { z } from "zod";
import { githubRepoFromUrl } from "@slop-bucket/core";
import type { Deps } from "./deps.ts";
import { USER_AGENT, getJson, githubHeaders } from "./http.ts";

// About 3,000 tokens.
export const MAX_TEXT_CHARS = 12_000;
// Raw bytes read from any linked page or README; the rest is never downloaded.
export const MAX_BODY_BYTES = 2_000_000;

export const articleKey = (postId: number) => `text/${postId}.txt`;

interface PostRef {
  id: number;
  url: string;
}

/**
 * Stage 2 of classification: the post's main text, from the R2 cache if present.
 * Fetch failures are logged and yield "", so the classifier still runs on the title.
 */
export async function getArticleText(post: PostRef, deps: Deps): Promise<string> {
  const cached = await deps.articles.get(articleKey(post.id));
  if (cached) return cached.text();

  let text = "";
  try {
    text = tidy(await extract(post.url, deps)).slice(0, MAX_TEXT_CHARS);
  } catch (err) {
    console.warn(JSON.stringify({ event: "content_fetch_failed", post_id: post.id, url: post.url, error: String(err) }));
  }
  if (text) {
    await deps.articles.put(articleKey(post.id), text, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
  }
  return text;
}

async function extract(url: string, deps: Deps): Promise<string> {
  const repo = githubRepoFromUrl(url);
  if (repo) return fetchReadme(repo, deps);

  const hnItem = url.match(/^https:\/\/news\.ycombinator\.com\/item\?id=(\d+)$/);
  if (hnItem) {
    const item = z.object({ text: z.string().nullable().optional() }).parse(
      await getJson(deps.fetch, `https://hn.algolia.com/api/v1/items/${hnItem[1]}`),
    );
    return item.text ? htmlToText(item.text) : "";
  }

  const lobstersStory = url.match(/^https:\/\/lobste\.rs\/s\/(\w+)/);
  if (lobstersStory) {
    const story = z.object({ description_plain: z.string().nullable().optional() }).parse(
      await getJson(deps.fetch, `https://lobste.rs/s/${lobstersStory[1]}.json`),
    );
    return story.description_plain ?? "";
  }

  const res = await deps.fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("text/plain") || type.includes("markdown")) return readCapped(res);
  if (!type.includes("html")) {
    await res.body?.cancel();
    return "";
  }
  return readable(await readCapped(res));
}

async function fetchReadme(repo: string, deps: Deps): Promise<string> {
  const headers = githubHeaders(deps.githubToken, "application/vnd.github.raw+json");
  const api = await deps.fetch(`https://api.github.com/repos/${repo}/readme`, { headers, signal: AbortSignal.timeout(15_000) });
  if (api.ok) return readCapped(api);
  // Unauthenticated API calls are rate limited; raw.githubusercontent.com is not.
  const raw = await deps.fetch(`https://raw.githubusercontent.com/${repo}/HEAD/README.md`, {
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  });
  if (raw.ok) return readCapped(raw);
  throw new Error(`README for ${repo}: api ${api.status}, raw ${raw.status}`);
}

/** Reads at most `maxBytes` of a body, so a huge or endless response cannot exhaust Worker memory. */
export async function readCapped(res: Response, maxBytes = MAX_BODY_BYTES): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value.byteLength > maxBytes - bytes ? value.subarray(0, maxBytes - bytes) : value;
    bytes += chunk.byteLength;
    text += decoder.decode(chunk, { stream: true });
    if (bytes >= maxBytes) {
      await reader.cancel();
      break;
    }
  }
  return text + decoder.decode();
}

/** Main text via Mozilla Readability, falling back to the whole body. */
export function readable(html: string): string {
  const { document } = parseHTML(html);
  const fallback = document.body?.textContent ?? "";
  const article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0]).parse();
  return article?.textContent || fallback;
}

function htmlToText(html: string): string {
  const { document } = parseHTML(`<!doctype html><html><body>${html.replace(/<p>/g, "\n\n<p>")}</body></html>`);
  return document.body?.textContent ?? "";
}

function tidy(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/[ \t ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
