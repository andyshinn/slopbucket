import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/lib/markdown.ts";

describe("renderMarkdown", () => {
  it("renders a README's headings, emphasis, code and tables", () => {
    const html = renderMarkdown(
      "# Paldron\n\n**Decide whether it may run.** Exits `0` allow.\n\n| Platform | check |\n|---|---|\n| Linux | yes |\n\n```sh\nbrew install paldron\n```",
    );
    expect(html).toContain("<h1>Paldron</h1>");
    expect(html).toContain("<strong>Decide whether it may run.</strong>");
    expect(html).toContain("<code>0</code>");
    expect(html).toContain("<table>");
    expect(html).toContain("<td>Linux</td>");
    expect(html).toContain('<pre><code class="language-sh">brew install paldron');
  });

  it("keeps plain text's line breaks", () => {
    expect(renderMarkdown("first line\nsecond line")).toBe("<p>first line<br>second line</p>\n");
  });

  it("shows raw HTML as text", () => {
    const html = renderMarkdown('<p align="center"><img src="https://x.test/logo.png" onerror="alert(1)"></p>\n\nHi <script>alert(1)</script> there');
    expect(html).not.toMatch(/<(p align|img|script)/);
    expect(html).toContain("&lt;img src=");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("links http(s) targets only, in a new tab", () => {
    const html = renderMarkdown('[docs](https://paldron.dev/docs "The \\"docs\\"") and [bad](javascript:alert(1)) and [rel](./CONTRIBUTING.md)');
    expect(html).toContain('<a href="https://paldron.dev/docs" title="The &quot;docs&quot;" target="_blank" rel="noopener noreferrer nofollow">docs</a>');
    expect(html).not.toContain("javascript:");
    expect(html).toContain(" bad and rel");
  });

  it("turns images into links instead of loading them", () => {
    const html = renderMarkdown('![build "status"](https://img.shields.io/badge.svg) ![](data:image/png;base64,AAAA)');
    expect(html).not.toContain("<img");
    expect(html).toContain('<a href="https://img.shields.io/badge.svg" target="_blank" rel="noopener noreferrer nofollow">[image: build &quot;status&quot;]</a>');
    expect(html).toContain("[image]");
    expect(html).not.toContain("data:");
  });

  it("escapes text and autolinks", () => {
    const html = renderMarkdown('a < b & "c" <https://x.test/?a="><script>>');
    expect(html).not.toContain("<script");
    expect(html).toContain("a &lt; b &amp;");
  });
});
