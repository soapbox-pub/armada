import { describe, expect, it } from "vitest";

import { receiveSharePost, SHARE_INBOX_CACHE, takeSharedFiles } from "@/lib/webShareInbox";

const ORIGIN = "https://armada.buzz";

/** Just enough Cache Storage for the inbox: keyed by URL, bodies kept as Responses. */
function fakeCaches(): CacheStorage & { store: Map<string, Map<string, Response>> } {
  const store = new Map<string, Map<string, Response>>();
  const openCache = (name: string): Cache => {
    let entries = store.get(name);
    if (!entries) {
      entries = new Map();
      store.set(name, entries);
    }
    const map = entries;
    return {
      async put(req: RequestInfo | URL, res: Response) {
        map.set(String(req instanceof Request ? req.url : req), res);
      },
      async match(req: RequestInfo | URL) {
        return map.get(String(req instanceof Request ? req.url : req))?.clone();
      },
      async keys() {
        return [...map.keys()].map((url) => new Request(url));
      },
    } as unknown as Cache;
  };
  return {
    store,
    async open(name: string) {
      return openCache(name);
    },
    async has(name: string) {
      return store.has(name);
    },
    async delete(name: string) {
      return store.delete(name);
    },
  } as unknown as CacheStorage & { store: Map<string, Map<string, Response>> };
}

function sharePost(form: FormData): Request {
  return new Request(`${ORIGIN}/share`, { method: "POST", body: form });
}

describe("web share inbox", () => {
  it("parks POSTed files and hands them back once, in order, with names and types", async () => {
    const caches = fakeCaches();
    const form = new FormData();
    form.set("text", "look");
    form.append("files", new File(["png bytes"], "cat 🐈.png", { type: "image/png" }));
    form.append("files", new File(["{}"], "notes.json", { type: "application/json" }));

    const res = await receiveSharePost(sharePost(form), caches, ORIGIN);
    expect(res.status).toBe(303);
    const target = new URL(res.headers.get("Location")!);
    expect(target.pathname).toBe("/share");
    expect(target.searchParams.get("text")).toBe("look");
    expect(target.searchParams.has("title")).toBe(false);
    const inbox = target.searchParams.get("inbox")!;

    const files = await takeSharedFiles(inbox, caches);
    expect(files.map((f) => [f.name, f.type])).toEqual([
      ["cat 🐈.png", "image/png"],
      ["notes.json", "application/json"],
    ]);
    expect(await files[0].text()).toBe("png bytes");
    expect(caches.store.has(SHARE_INBOX_CACHE)).toBe(false);
    expect(await takeSharedFiles(inbox, caches)).toEqual([]);
  });

  it("redirects a text-only share without parking anything", async () => {
    const caches = fakeCaches();
    const form = new FormData();
    form.set("title", "A page");
    form.set("url", "https://example.com/");

    const res = await receiveSharePost(sharePost(form), caches, ORIGIN);
    const target = new URL(res.headers.get("Location")!);
    expect(target.searchParams.get("title")).toBe("A page");
    expect(target.searchParams.get("url")).toBe("https://example.com/");
    expect(target.searchParams.has("inbox")).toBe(false);
    expect(caches.store.size).toBe(0);
  });

  it("drops an unclaimed earlier share when a new one arrives", async () => {
    const caches = fakeCaches();
    const post = async (name: string) => {
      const form = new FormData();
      form.append("files", new File(["x"], name));
      const res = await receiveSharePost(sharePost(form), caches, ORIGIN);
      return new URL(res.headers.get("Location")!).searchParams.get("inbox")!;
    };
    const first = await post("a.txt");
    const second = await post("b.txt");

    expect(await takeSharedFiles(first, caches)).toEqual([]);
    expect((await takeSharedFiles(second, caches)).map((f) => f.name)).toEqual(["b.txt"]);
  });

  it("refuses an inbox id that isn't one it minted", async () => {
    const caches = fakeCaches();
    expect(await takeSharedFiles("../etc", caches)).toEqual([]);
  });
});
