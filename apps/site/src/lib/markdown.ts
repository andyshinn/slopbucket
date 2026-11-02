import { Marked, type Tokens } from "marked";
import { safeHref } from "./ui.ts";

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * Markdown for text fetched from anywhere (READMEs, linked pages), so nothing in it is trusted:
 * raw HTML is shown as text, links keep only http(s) targets and open in a new tab,
 * and images become their alt text with a link instead of loading from a third party.
 */
const marked = new Marked({
  gfm: true,
  // Most stored text is plain (Readability, HN, lobste.rs) and keeps its line breaks.
  breaks: true,
  async: false,
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(text);
    },
    link({ href, title, tokens }: Tokens.Link) {
      const label = this.parser.parseInline(tokens);
      const url = safeHref(href);
      if (!url) return label;
      const t = title ? ` title="${escapeHtml(title)}"` : "";
      return `<a href="${escapeHtml(url)}"${t} target="_blank" rel="noopener noreferrer nofollow">${label}</a>`;
    },
    image({ href, text }: Tokens.Image) {
      const label = `[image${text ? `: ${escapeHtml(text)}` : ""}]`;
      const url = safeHref(href);
      return url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer nofollow">${label}</a>` : label;
    },
  },
});

/** Renders untrusted markdown (or plain text) to HTML that is safe to inject with set:html. */
export function renderMarkdown(text: string): string {
  return marked.parse(text, { async: false });
}
