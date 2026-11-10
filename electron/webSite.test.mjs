// @vitest-environment node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadSite,
  parseDesktopManifest,
  pinSite,
  pruneBlobs,
  readBlob,
  readShippedDesktopManifest,
  resolveSitePath,
  stageSite,
} from "./webSite.js";

const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const SHELL = { shellApi: 2, shellVersion: "1.2.0", floor: 1_000 };

/**
 * The stand-in for updateFeed.cjs's parseWebSite: what it accepts here is an
 * event marked `trusted`, which is the only property of the real check these
 * tests depend on (the real one is covered in desktopUpdate.test.ts).
 */
function parse(event) {
  if (!event?.trusted) return undefined;
  return {
    event,
    id: event.id,
    siteId: event.track ?? "armada",
    createdAt: event.created_at,
    files: new Map(event.paths),
    servers: event.servers,
  };
}

function makeSite({ id = "site-1", createdAt = 2_000, api = 2, version = "1.2.0", track = "armada", extra = {} } = {}) {
  const contents = {
    "/index.html": Buffer.from(`<html>${id}</html>`),
    "/assets/app.js": Buffer.from(`console.log(${JSON.stringify(id)})`),
    "/desktop.json": Buffer.from(JSON.stringify({ api, builtAt: createdAt })),
    "/CHANGELOG.md": Buffer.from(`# Changelog\n\n## [${version}]\n`),
    "/downloads/armada-web.tar.gz": Buffer.from("archive"),
    ...extra,
  };
  const paths = Object.entries(contents).map(([sitePath, bytes]) => [sitePath, sha(bytes)]);
  const event = { id, created_at: createdAt, trusted: true, track, paths, servers: ["https://one.example", "https://two.example"] };
  return { site: parse(event), contents, blobs: new Map(Object.values(contents).map((bytes) => [sha(bytes), bytes])) };
}

/** A fetch over Blossom servers: `serves[origin]` maps sha256 → bytes. */
function blossom(serves) {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    const { origin, pathname } = new URL(url);
    const bytes = serves[origin]?.get(pathname.slice(1));
    if (!bytes) return new Response("missing", { status: 404 });
    return new Response(bytes, { status: 200 });
  };
  return { fetchImpl, requests };
}

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "armada-site-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function install(fixture, options = {}) {
  const { fetchImpl } = blossom({ "https://one.example": fixture.blobs });
  return stageSite({ dir, site: fixture.site, active: null, parse, ...SHELL, fetchImpl, ...options });
}

describe("stageSite", () => {
  it("downloads every served file, writes the manifest, and skips the deploy archives", async () => {
    const fixture = makeSite();
    const { fetchImpl, requests } = blossom({ "https://one.example": fixture.blobs });
    const outcome = await stageSite({ dir, site: fixture.site, active: null, parse, ...SHELL, fetchImpl });
    expect(outcome).toEqual({ result: "installed", id: "site-1" });
    expect(JSON.parse(fs.readFileSync(path.join(dir, "current.json"), "utf8")).id).toBe("site-1");
    expect(readBlob(dir, sha(fixture.contents["/index.html"]))).toEqual(fixture.contents["/index.html"]);
    expect(requests.some((url) => url.endsWith(sha(fixture.contents["/downloads/armada-web.tar.gz"])))).toBe(false);
  });

  it("downloads only the files the previous site did not already have", async () => {
    const first = makeSite();
    await install(first);
    const next = makeSite({ id: "site-2", createdAt: 3_000, extra: { "/assets/app.js": first.contents["/assets/app.js"] } });
    const { fetchImpl, requests } = blossom({ "https://one.example": next.blobs });
    await stageSite({ dir, site: next.site, active: null, parse, ...SHELL, fetchImpl });
    expect(requests.map((url) => url.split("/").pop()).sort()).toEqual(
      [sha(next.contents["/index.html"]), sha(next.contents["/desktop.json"])].sort(),
    );
  });

  it("moves to the next server when one is down or serves the wrong bytes", async () => {
    const fixture = makeSite();
    const wrong = new Map([...fixture.blobs.keys()].map((hash) => [hash, Buffer.from("tampered")]));
    const { fetchImpl } = blossom({ "https://one.example": wrong, "https://two.example": fixture.blobs });
    const outcome = await stageSite({ dir, site: fixture.site, active: null, parse, ...SHELL, fetchImpl });
    expect(outcome.result).toBe("installed");
    for (const [hash, bytes] of fixture.blobs) {
      if (fs.existsSync(path.join(dir, "blobs", hash))) expect(readBlob(dir, hash)).toEqual(bytes);
    }
  });

  it("leaves the stored site untouched when a blob cannot be had", async () => {
    await install(makeSite());
    const next = makeSite({ id: "site-2", createdAt: 3_000, extra: { "/assets/app.js": Buffer.from("new chunk") } });
    const partial = new Map(next.blobs);
    partial.delete(sha(next.contents["/assets/app.js"]));
    const { fetchImpl } = blossom({ "https://one.example": partial });
    await expect(stageSite({ dir, site: next.site, active: null, parse, ...SHELL, fetchImpl })).rejects.toThrow();
    expect(loadSite({ dir, parse, ...SHELL })?.id).toBe("site-1");
  });

  it("refuses a manifest older than the stored one or no newer than the shell's floor", async () => {
    await install(makeSite({ createdAt: 3_000 }));
    expect(await install(makeSite({ id: "older", createdAt: 2_500 }))).toEqual({ result: "unchanged" });
    fs.rmSync(path.join(dir, "current.json"));
    expect(await install(makeSite({ id: "floor", createdAt: SHELL.floor }))).toEqual({ result: "unchanged" });
  });

  it("takes an older site from the other track, which is the user switching channel", async () => {
    await install(makeSite({ createdAt: 3_000 }));
    const release = makeSite({ id: "release", createdAt: 2_500, track: "armada-release", extra: { "/assets/app.js": Buffer.from("release") } });
    expect(await install(release)).toEqual({ result: "installed", id: "release" });
    // Within the release track the rollback guard holds again.
    expect(await install(makeSite({ id: "stale", createdAt: 2_400, track: "armada-release" }))).toEqual({ result: "unchanged" });
    expect(loadSite({ dir, parse, ...SHELL })?.id).toBe("release");
  });

  it("reports a site that needs a newer shell without downloading the rest", async () => {
    const fixture = makeSite({ api: 3 });
    const { fetchImpl, requests } = blossom({ "https://one.example": fixture.blobs });
    expect(await stageSite({ dir, site: fixture.site, active: null, parse, ...SHELL, fetchImpl })).toEqual({
      result: "incompatible",
      id: "site-1",
    });
    expect(requests).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, "current.json"))).toBe(false);
  });

  it("refuses a site whose CHANGELOG version is older than the shell", async () => {
    expect(await install(makeSite({ version: "1.1.9" }))).toEqual({ result: "unchanged" });
    expect(fs.existsSync(path.join(dir, "current.json"))).toBe(false);
  });

  it("refuses a site with no desktop.json, so it predates the API check", async () => {
    const fixture = makeSite();
    fixture.site.files.delete("/desktop.json");
    expect(await install(fixture)).toEqual({ result: "unchanged" });
  });

  it("answers unchanged for the site already running, and restores its missing blobs", async () => {
    const fixture = makeSite();
    await install(fixture);
    const active = loadSite({ dir, parse, ...SHELL });
    const chunk = sha(fixture.contents["/assets/app.js"]);
    fs.rmSync(path.join(dir, "blobs", chunk));
    expect(await install(fixture, { active })).toEqual({ result: "unchanged" });
    expect(readBlob(dir, chunk)).not.toBeNull();
  });

  it("keeps the running site's blobs until the restart and prunes the rest", async () => {
    const first = makeSite();
    await install(first);
    const active = loadSite({ dir, parse, ...SHELL });
    const second = makeSite({ id: "site-2", createdAt: 3_000, extra: { "/assets/app.js": Buffer.from("two") } });
    await install(second, { active });
    const third = makeSite({ id: "site-3", createdAt: 4_000, extra: { "/assets/app.js": Buffer.from("three") } });
    await install(third, { active });
    expect(readBlob(dir, sha(first.contents["/assets/app.js"]))).not.toBeNull();
    expect(fs.existsSync(path.join(dir, "blobs", sha(Buffer.from("two"))))).toBe(false);
    expect(loadSite({ dir, parse, ...SHELL })?.id).toBe("site-3");
  });
});

describe("pinSite", () => {
  it("discards a staged site so the next launch serves the running one", async () => {
    await install(makeSite());
    const running = loadSite({ dir, parse, ...SHELL });
    await install(makeSite({ id: "site-2", createdAt: 3_000, extra: { "/assets/app.js": Buffer.from("two") } }), { active: running });
    expect(loadSite({ dir, parse, ...SHELL })?.id).toBe("site-2");
    pinSite({ dir, active: running });
    expect(loadSite({ dir, parse, ...SHELL })?.id).toBe("site-1");
  });

  it("goes back to the shipped bundle when that is what is running", async () => {
    await install(makeSite());
    pinSite({ dir, active: null });
    expect(loadSite({ dir, parse, ...SHELL })).toBeNull();
  });
});

describe("loadSite", () => {
  it("serves the stored site once every file is present", async () => {
    await install(makeSite());
    const site = loadSite({ dir, parse, ...SHELL });
    expect(site?.id).toBe("site-1");
    expect(site?.files.has("/downloads/armada-web.tar.gz")).toBe(false);
  });

  it("falls back to the shipped bundle for a stored manifest the check refuses", async () => {
    await install(makeSite());
    const stored = JSON.parse(fs.readFileSync(path.join(dir, "current.json"), "utf8"));
    fs.writeFileSync(path.join(dir, "current.json"), JSON.stringify({ ...stored, trusted: false }));
    expect(loadSite({ dir, parse, ...SHELL })).toBeNull();
    fs.writeFileSync(path.join(dir, "current.json"), "{not json");
    expect(loadSite({ dir, parse, ...SHELL })).toBeNull();
  });

  it("falls back when a file is missing, the floor has passed it, or the shell is too old", async () => {
    const fixture = makeSite();
    await install(fixture);
    expect(loadSite({ dir, parse, ...SHELL, floor: 2_000 })).toBeNull();
    expect(loadSite({ dir, parse, ...SHELL, shellApi: 1 })).toBeNull();
    fs.rmSync(path.join(dir, "blobs", sha(fixture.contents["/assets/app.js"])));
    expect(loadSite({ dir, parse, ...SHELL })).toBeNull();
  });

  it("falls back when desktop.json was altered on disk", async () => {
    const fixture = makeSite();
    await install(fixture);
    fs.writeFileSync(path.join(dir, "blobs", sha(fixture.contents["/desktop.json"])), JSON.stringify({ api: 1 }));
    expect(loadSite({ dir, parse, ...SHELL })).toBeNull();
  });

  it("is null with nothing stored", () => {
    expect(loadSite({ dir, parse, ...SHELL })).toBeNull();
  });
});

describe("serving", () => {
  it("answers a file, else index.html for the router", async () => {
    await install(makeSite());
    const site = loadSite({ dir, parse, ...SHELL });
    expect(resolveSitePath(site, "/")).toBe("/index.html");
    expect(resolveSitePath(site, "/assets/app.js")).toBe("/assets/app.js");
    expect(resolveSitePath(site, "/s/relay.example/group")).toBe("/index.html");
    expect(resolveSitePath(site, "/downloads/armada-web.tar.gz")).toBe("/index.html");
  });

  it("never returns bytes that no longer match their hash", async () => {
    const fixture = makeSite();
    await install(fixture);
    const hash = sha(fixture.contents["/assets/app.js"]);
    fs.writeFileSync(path.join(dir, "blobs", hash), "planted");
    expect(readBlob(dir, hash)).toBeNull();
    expect(readBlob(dir, "../current.json")).toBeNull();
  });
});

describe("pruneBlobs", () => {
  it("removes blobs and leftover temp files no kept site names", async () => {
    const fixture = makeSite();
    await install(fixture);
    fs.writeFileSync(path.join(dir, "blobs", `${"f".repeat(64)}.abc.tmp`), "partial");
    pruneBlobs(dir, [loadSite({ dir, parse, ...SHELL })]);
    expect(fs.readdirSync(path.join(dir, "blobs")).sort()).toEqual(
      [...new Set(loadSite({ dir, parse, ...SHELL }).files.values())].sort(),
    );
  });
});

describe("desktop.json", () => {
  it("parses the level and build time, refusing anything without a level", () => {
    expect(parseDesktopManifest(Buffer.from('{"api":1,"builtAt":5}'))).toEqual({ api: 1, builtAt: 5 });
    expect(parseDesktopManifest(Buffer.from('{"builtAt":5}'))).toBeNull();
    expect(parseDesktopManifest(Buffer.from("nope"))).toBeNull();
    expect(parseDesktopManifest(null)).toBeNull();
  });

  it("reads the shell's own copy from its shipped bundle", () => {
    fs.writeFileSync(path.join(dir, "desktop.json"), '{"api":1,"builtAt":42}');
    expect(readShippedDesktopManifest(dir)).toEqual({ api: 1, builtAt: 42 });
    expect(readShippedDesktopManifest(path.join(dir, "missing"))).toBeNull();
  });
});
