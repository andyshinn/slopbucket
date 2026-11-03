import { describe, expect, it } from "vitest";
import { proxiedImage, refResolver, renderMarkdown } from "../src/lib/markdown.ts";

const README = "https://github.com/gregdixonmxn/paldron";
const readme = refResolver(README);
const page = refResolver("https://paldron.dev/blog/launch");
const proxied = (url: string) => proxiedImage(url).replace(/&/g, "&#x26;");

describe("renderMarkdown", () => {
  it("renders a README's headings, emphasis, code and tables", () => {
    const html = renderMarkdown(
      "# Paldron\n\n**Decide whether it may run.** Exits `0` allow.\n\n| Platform | check |\n|---|---|\n| Linux | yes |\n\n```sh\nbrew install paldron\n```",
      readme,
    );
    expect(html).toContain("<h1>Paldron</h1>");
    expect(html).toContain("<strong>Decide whether it may run.</strong>");
    expect(html).toContain("<code>0</code>");
    expect(html).toContain("<td>Linux</td>");
    expect(html).toContain('<pre><code class="language-sh">brew install paldron');
  });

  it("keeps plain text's line breaks", () => {
    expect(renderMarkdown("first line\nsecond line", page)).toBe("<p>first line<br>\nsecond line</p>");
  });

  it("renders the HTML GitHub allows", () => {
    const html = renderMarkdown(
      '<p align="center"><b>Paldron</b></p>\n\n<details><summary>More</summary>\n\nHidden <kbd>Ctrl</kbd>\n\n</details>',
      readme,
    );
    expect(html).toContain('<p align="center"><b>Paldron</b></p>');
    expect(html).toContain("<details><summary>More</summary>");
    expect(html).toContain("<kbd>Ctrl</kbd>");
  });

  it("strips scripts, handlers, styles and javascript: URLs", () => {
    const html = renderMarkdown(
      '<p style="color:red" onclick="alert(1)">Hi</p>\n\n<script>alert(1)</script>\n\n<a href="javascript:alert(1)">bad</a> <iframe src="https://x.test"></iframe> [md](javascript:alert(1))',
      readme,
    );
    expect(html).not.toMatch(/script|onclick|style=|iframe|javascript:/);
    expect(html).toContain("<p>Hi</p>");
    expect(html).toContain("<a>bad</a>");
  });

  it("opens links in a new tab, resolving a README's relative links on GitHub", () => {
    const html = renderMarkdown("[docs](https://paldron.dev/docs) [contributing](./CONTRIBUTING.md) [root](/docs/a.md)", readme);
    expect(html).toContain('<a href="https://paldron.dev/docs" target="_blank" rel="noopener noreferrer nofollow">docs</a>');
    expect(html).toContain(`href="${README}/blob/HEAD/CONTRIBUTING.md"`);
    expect(html).toContain(`href="${README}/blob/HEAD/docs/a.md"`);
  });

  it("loads images through the proxy, from the repo's raw files", () => {
    const html = renderMarkdown(
      '<img src="docs/logo.png" width="120" alt="Logo" onerror="alert(1)">\n\n![badge](https://img.shields.io/badge/ci-passing.svg) ![blob](https://github.com/acme/x/blob/main/a.png)',
      readme,
    );
    expect(html).toContain(`src="${proxied("https://raw.githubusercontent.com/gregdixonmxn/paldron/HEAD/docs/logo.png")}"`);
    expect(html).toContain('width="120"');
    expect(html).not.toContain("onerror");
    expect(html).toContain(`src="${proxied("https://img.shields.io/badge/ci-passing.svg")}"`);
    expect(html).toContain(`src="${proxied("https://github.com/acme/x/raw/main/a.png")}"`);
    expect(html.match(/src="(?!\/admin\/image\?url=)/g)).toBeNull();
  });

  it("drops images and sources that would load from elsewhere", () => {
    const html = renderMarkdown(
      '<picture><source media="(prefers-color-scheme: dark)" srcset="https://x.test/dark.png"><img src="https://x.test/light.png" alt="Logo"></picture>\n\n![inline](data:image/png;base64,AAAA)',
      readme,
    );
    expect(html).not.toContain("<source");
    expect(html).not.toContain("x.test/dark.png");
    expect(html).toContain(`src="${proxied("https://x.test/light.png")}"`);
    expect(html).not.toContain("data:");
    expect(html).toContain("inline");
  });

  it("resolves other posts' references against the post URL", () => {
    const html = renderMarkdown("![shot](img/shot.png) [more](/about)", page);
    expect(html).toContain(`src="${proxied("https://paldron.dev/blog/img/shot.png")}"`);
    expect(html).toContain('href="https://paldron.dev/about"');
  });
});

describe("renderMarkdown with a length cap", () => {
  it("notes the cut after the HTML, so an open code fence can't swallow it", () => {
    const text = "Intro\n\n```sh\ncargo install paldron\ncargo run --release\n```\n\nAfter";
    const html = renderMarkdown(text, readme, text.indexOf("cargo run"));
    expect(html).toContain('<pre><code class="language-sh">cargo install paldron\n</code></pre>');
    expect(html).toMatch(/<\/pre>\n<p class="markdown-cut">… Showing the first \d+ of \d+ characters\.<\/p>$/);
    expect(html).not.toContain("After");
  });

  it("closes HTML cut mid-tag", () => {
    const html = renderMarkdown('<details><summary>More</summary>\n\nText <img src="https://x.test/a.png" onerror="alert(1)"', readme, 60);
    expect(html).not.toContain("onerror");
    expect(html).toContain("</details>");
  });

  it("adds no note when the text fits", () => {
    expect(renderMarkdown("short", page, 6000)).toBe("<p>short</p>");
  });
});
