import { githubRepoFromUrl } from "@slop-bucket/core";
import type { Element, Root, RootContent } from "hast";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { num, safeHref } from "./ui.ts";

/** Resolves a link or image reference from the text to an absolute URL, or null to drop it. */
export type ResolveRef = (ref: string, kind: "link" | "image") => string | null;

/**
 * How references in a post's text resolve. A GitHub README resolves like it does on GitHub:
 * images from the repo's raw files, links to the repo's file pages, and "/x" from the repo root.
 * Anything else resolves against the post's URL.
 */
export function refResolver(postUrl: string): ResolveRef {
  const repo = githubRepoFromUrl(postUrl);
  if (!repo) {
    return (ref) => {
      try {
        return safeHref(new URL(ref, postUrl).href);
      } catch {
        return null;
      }
    };
  }
  const bases = { image: `https://raw.githubusercontent.com/${repo}/HEAD/`, link: `https://github.com/${repo}/blob/HEAD/` };
  return (ref, kind) => {
    let url: URL;
    try {
      // "/docs/x.png" in a README means the repo root, not the host root.
      url = new URL(/^\/(?!\/)/.test(ref) ? ref.slice(1) : ref, bases[kind]);
    } catch {
      return null;
    }
    // GitHub serves a file page at /blob/ and the file itself at /raw/.
    if (kind === "image" && url.hostname === "github.com") url.pathname = url.pathname.replace(/^(\/[^/]+\/[^/]+)\/blob\//, "$1/raw/");
    return safeHref(url.href);
  };
}

/** Where the queue's images load from: the site Worker fetches them, so the browser never contacts the image's host. */
export const proxiedImage = (url: string) => `/admin/image?url=${encodeURIComponent(url)}`;

/**
 * After sanitizing: resolve every link and image, open links in a new tab, route images
 * through the proxy, and drop anything that would still load from elsewhere.
 */
function rehypeLinksAndImages(resolve: ResolveRef) {
  const fix = (parent: Root | Element) => {
    const kept: RootContent[] = [];
    for (const node of parent.children) {
      if (node.type !== "element") {
        kept.push(node);
        continue;
      }
      const p = node.properties;
      // <picture> falls back to its <img>; a <source srcset> would load directly.
      if (node.tagName === "source") continue;
      if (node.tagName === "img") {
        const src = typeof p.src === "string" ? resolve(p.src, "image") : null;
        delete p.longDesc;
        if (!src) {
          if (typeof p.alt === "string" && p.alt) kept.push({ type: "text", value: p.alt });
          continue;
        }
        p.src = proxiedImage(src);
        p.loading = "lazy";
      }
      if (node.tagName === "a" && p.href !== undefined) {
        const href = typeof p.href === "string" ? resolve(p.href, "link") : null;
        if (href) {
          p.href = href;
          p.target = "_blank";
          p.rel = ["noopener", "noreferrer", "nofollow"];
        } else {
          delete p.href;
        }
      }
      fix(node);
      kept.push(node);
    }
    parent.children = kept as typeof parent.children;
  };
  return () => (tree: Root) => fix(tree);
}

const pipeline = (resolve: ResolveRef) =>
  unified()
    .use(remarkParse)
    .use(remarkGfm)
    // Most stored text is plain (Readability, HN, lobste.rs) and keeps its line breaks.
    .use(remarkBreaks)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    // GitHub's allowlist: no scripts, event handlers, styles or javascript: URLs.
    .use(rehypeSanitize, defaultSchema)
    .use(rehypeLinksAndImages(resolve))
    .use(rehypeStringify);

/**
 * Renders untrusted markdown with inline HTML (or plain text) the way GitHub does, as HTML
 * that is safe to inject with set:html. Text over `maxChars` is cut there, and a note follows
 * the rendered HTML, outside the markdown, so a cut inside a code fence or table can't swallow it.
 */
export function renderMarkdown(text: string, resolve: ResolveRef, maxChars = Infinity): string {
  const html = String(pipeline(resolve).processSync(text.slice(0, maxChars)));
  if (text.length <= maxChars) return html;
  return `${html}\n<p class="markdown-cut">… Showing the first ${num(maxChars)} of ${num(text.length)} characters.</p>`;
}
