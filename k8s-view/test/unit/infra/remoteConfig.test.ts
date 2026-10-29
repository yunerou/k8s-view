import { describe, expect, test } from "vitest";
import {
  downloadRemoteConfig,
  type FetchLike,
  MAX_REMOTE_BYTES,
  normalizeRemoteUrl,
  sha256,
} from "../../../src/infra/config/remoteConfig";

/** Fake fetch: URL → response; records requested URLs. */
function fakeFetch(routes: Record<string, () => Response>): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const fn = async (url: URL) => {
    calls.push(url.toString());
    const route = routes[url.toString()];
    if (!route) return new Response("not found", { status: 404 });
    return route();
  };
  return Object.assign(fn, { calls });
}
const redirect = (location: string) => () => new Response(null, { status: 302, headers: { location } });

describe("normalizeRemoteUrl", () => {
  test("a gist page loads its raw content; raw URLs are untouched", () => {
    expect(normalizeRemoteUrl("https://gist.github.com/alice/0123abcd")).toBe(
      "https://gist.github.com/alice/0123abcd/raw",
    );
    const raw = "https://gist.githubusercontent.com/alice/0123abcd/raw/f00/k8s-view.json";
    expect(normalizeRemoteUrl(raw)).toBe(raw);
  });
});

describe("downloadRemoteConfig", () => {
  test("follows https redirects", async () => {
    const f = fakeFetch({
      "https://gist.github.com/alice/0123abcd/raw": redirect("https://gist.githubusercontent.com/alice/x.json"),
      "https://gist.githubusercontent.com/alice/x.json": () => new Response('{"version":1}'),
    });
    expect(await downloadRemoteConfig("https://gist.github.com/alice/0123abcd", f)).toBe('{"version":1}');
    expect(f.calls).toHaveLength(2);
  });

  test("refuses http, also after a redirect, and URLs with credentials", async () => {
    const f = fakeFetch({ "https://a.example/c.json": redirect("http://a.example/c.json") });
    await expect(downloadRemoteConfig("http://a.example/c.json", f)).rejects.toThrow("only https");
    await expect(downloadRemoteConfig("https://a.example/c.json", f)).rejects.toThrow("only https");
    expect(f.calls).toEqual(["https://a.example/c.json"]);
    await expect(downloadRemoteConfig("https://u:p@a.example/c.json", f)).rejects.toThrow("credentials");
  });

  test("HTTP errors, redirect loops and oversized files fail", async () => {
    const f = fakeFetch({
      "https://a.example/loop": redirect("https://a.example/loop"),
      "https://a.example/big": () => new Response("x".repeat(MAX_REMOTE_BYTES + 1)),
    });
    await expect(downloadRemoteConfig("https://a.example/missing", f)).rejects.toThrow("HTTP 404");
    await expect(downloadRemoteConfig("https://a.example/loop", f)).rejects.toThrow("too many redirects");
    await expect(downloadRemoteConfig("https://a.example/big", f)).rejects.toThrow("larger than");
  });

  test("sha256 is hex of the UTF-8 content", () => {
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
