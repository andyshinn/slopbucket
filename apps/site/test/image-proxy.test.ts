import { describe, expect, it } from "vitest";
import { MAX_IMAGE_BYTES, proxyImage } from "../src/lib/image-proxy.ts";

const upstream = (body: BodyInit | null, headers: Record<string, string>, status = 200) => {
  const calls: string[] = [];
  const fetcher = (async (url: string) => {
    calls.push(url);
    return new Response(body, { status, headers });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
};

describe("proxyImage", () => {
  it("serves an image with sandboxing headers and a private cache", async () => {
    const { fetcher, calls } = upstream("<svg xmlns='http://www.w3.org/2000/svg'/>", { "content-type": "image/svg+xml; charset=utf-8" });
    const res = await proxyImage("https://img.shields.io/badge/ci-passing.svg", fetcher);
    expect(calls).toEqual(["https://img.shields.io/badge/ci-passing.svg"]);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(await res.text()).toContain("<svg");
  });

  it("refuses anything but http(s) URLs without fetching", async () => {
    const { fetcher, calls } = upstream("x", { "content-type": "image/png" });
    for (const url of [null, "", "javascript:alert(1)", "data:image/png;base64,AAAA", "file:///etc/passwd", "/admin/image"]) {
      expect((await proxyImage(url, fetcher)).status).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it("refuses responses that aren't images", async () => {
    const { fetcher } = upstream("<html>", { "content-type": "text/html" });
    const res = await proxyImage("https://x.test/page", fetcher);
    expect(res.status).toBe(415);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("");
  });

  it("passes upstream errors and network failures on as empty errors", async () => {
    expect((await proxyImage("https://x.test/a.png", upstream(null, { "content-type": "image/png" }, 404).fetcher)).status).toBe(404);
    const throwing = (async () => {
      throw new Error("timeout");
    }) as unknown as typeof fetch;
    expect((await proxyImage("https://x.test/a.png", throwing)).status).toBe(502);
  });

  it("refuses an image declared too large, and cuts off one that turns out to be", async () => {
    const declared = upstream("x", { "content-type": "image/png", "content-length": String(MAX_IMAGE_BYTES + 1) });
    expect((await proxyImage("https://x.test/a.png", declared.fetcher)).status).toBe(415);

    const big = upstream(new Uint8Array(MAX_IMAGE_BYTES + 1), { "content-type": "image/png" });
    const res = await proxyImage("https://x.test/a.png", big.fetcher);
    expect(res.status).toBe(200);
    await expect(res.arrayBuffer()).rejects.toThrow();
  });
});
