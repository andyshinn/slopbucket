import { Marked, type Tokens } from "marked";
import { escapeHtml, num, safeHref } from "./ui.ts";

/** The one way rendered markdown links out, so the safety attributes can't drift apart. */
const anchor = (url: string, label: string, title?: string | null) =>
  `<a href="${escapeHtml(url)}"${title ? ` title="${escapeHtml(title)}"` : ""} target="_blank" rel="noopener noreferrer nofollow">${label}</a>`;

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
      return url ? anchor(url, label, title) : label;
    },
    image({ href, text }: Tokens.Image) {
      const label = `[image${text ? `: ${escapeHtml(text)}` : ""}]`;
      const url = safeHref(href);
      return url ? anchor(url, label) : label;
    },
  },
});

/**
 * Renders untrusted markdown (or plain text) to HTML that is safe to inject with set:html.
 * Text over `maxChars` is cut there, and a note follows the rendered HTML, outside the markdown,
 * so a cut inside a code fence or table can't swallow it.
 */
export function renderMarkdown(text: string, maxChars = Infinity): string {
  const html = marked.parse(text.slice(0, maxChars), { async: false });
  if (text.length <= maxChars) return html;
  return `${html}<p class="markdown-cut">… Showing the first ${num(maxChars)} of ${num(text.length)} characters.</p>\n`;
}
