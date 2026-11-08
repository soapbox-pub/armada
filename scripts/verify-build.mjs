#!/usr/bin/env node
/**
 * Rebuilds the deployed web app from source and checks it against the signed
 * site manifest, file by file. The site is what the browser, the nsite
 * gateways and every desktop edition run, so this is the check that the code
 * people run is the code in this repository.
 *
 * Usage:
 *   node scripts/verify-build.mjs                    the live site, from the release relays
 *   node scripts/verify-build.mjs --manifest e.json  a specific kind-35128 event
 *   node scripts/verify-build.mjs --dist dist        compare a build you already made
 *   --keep                                           leave the checkout for inspection
 *
 * The manifest's `/build.json` (written by vite.config.ts) names the commit,
 * the build epoch and the deployment config the build was made with; this
 * checks the commit out into a temporary worktree, runs `npm ci && npm run
 * build` with exactly those inputs, and compares hashes. Toolchain versions
 * are recorded there too: a different Node, rustc or wasm-pack can change the
 * output, so a mismatch is reported first. `.ngit/ci-image/Dockerfile` is the
 * environment the deploy builds in.
 *
 * Files the deploy adds after `npm run build` (the spellcheck dictionaries,
 * the legacy `/downloads` archive) are listed as not checked rather than
 * passed.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const keep = args.includes("--keep");
const manifestFile = option("--manifest");
const prebuilt = option("--dist");

const log = (message) => console.log(message);
const fail = (message) => {
  console.error(`verify-build: ${message}`);
  process.exit(1);
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const run = (command, argv, options = {}) =>
  execFileSync(command, argv, { stdio: "inherit", ...options });

// The manifest is parsed by the same code the desktop shell trusts it with.
const feed = path.join(root, "electron/updateFeed.cjs");
if (!fs.existsSync(feed)) run("npm", ["run", "-s", "build:electron-update"], { cwd: root });
const { parseWebSite, resolveWebSite } = require(feed);

const site = manifestFile
  ? parseWebSite(JSON.parse(fs.readFileSync(manifestFile, "utf8")))
  : await resolveWebSite();
if (!site) fail("no site manifest signed by a release author was found");
log(`manifest ${site.id} (${new Date(site.createdAt * 1000).toISOString()}), ${site.files.size} files`);

async function fetchBlob(hash) {
  for (const server of site.servers) {
    try {
      const response = await fetch(`${server}/${hash}`, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) continue;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (sha256(bytes) === hash) return bytes;
    } catch { /* next server */ }
  }
  return undefined;
}

const infoHash = site.files.get("/build.json");
if (!infoHash) fail("the manifest has no /build.json, so it does not say which commit it was built from");
const infoBytes = await fetchBlob(infoHash);
if (!infoBytes) fail(`could not fetch /build.json (${infoHash}) from ${site.servers.join(", ")}`);
const info = JSON.parse(infoBytes.toString("utf8"));
if (!/^[0-9a-f]{40}$/.test(info.commit ?? "")) fail("/build.json names no commit");
log(`built from ${info.commit}${info.tag ? ` (${info.tag})` : ""}, version ${info.version}, epoch ${info.sourceDateEpoch}`);

const toolVersion = (command) => {
  try {
    return execFileSync(command, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};
const local = { node: process.version, rustc: toolVersion("rustc"), wasmPack: toolVersion("wasm-pack") };
for (const [tool, version] of Object.entries(info.toolchain ?? {})) {
  if ((tool === "rustc" || tool === "wasmPack") && !info.webxdcRt) continue;
  if (version !== local[tool]) log(`warning: built with ${tool} ${version}, you have ${local[tool] ?? "none"}`);
}

let workdir;
let dist = prebuilt && path.resolve(prebuilt);
if (!dist) {
  try {
    execFileSync("git", ["-C", root, "cat-file", "-e", `${info.commit}^{commit}`], { stdio: "ignore" });
  } catch {
    run("git", ["-C", root, "fetch", "origin", info.commit]);
  }
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "armada-verify-"));
  run("git", ["-C", root, "worktree", "add", "--detach", workdir, info.commit]);

  // Only the recorded config may reach the build: drop every name it reads
  // (and their VITE_ spellings) from this shell before applying the record.
  const source = fs.readFileSync(path.join(workdir, "src/build/buildConfig.ts"), "utf8");
  const list = source.match(/CONFIG_NAMES = \[([\s\S]*?)\] as const/)?.[1] ?? "";
  const names = [...list.matchAll(/^\s*"([A-Z0-9_]+)",/gm)].map((m) => m[1]);
  const env = { ...process.env };
  for (const name of names) {
    delete env[name];
    delete env[`VITE_${name}`];
  }
  delete env.CI_COMMIT_SHORT_SHA;
  Object.assign(env, info.config, {
    SOURCE_DATE_EPOCH: String(info.sourceDateEpoch),
    CI_COMMIT_TAG: info.tag ?? "",
    WEBXDC_RT_REQUIRED: info.webxdcRt ? "1" : "0",
  });

  run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: workdir, env });
  run("npm", ["run", "build"], { cwd: workdir, env });
  dist = path.join(workdir, "dist");
}

function walk(dir, prefix = "") {
  const files = new Map();
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const sitePath = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) for (const [p, h] of walk(full, sitePath)) files.set(p, h);
    else files.set(sitePath, sha256(fs.readFileSync(full)));
  }
  return files;
}
const built = walk(dist);

const mismatched = [];
const unchecked = [];
let matched = 0;
for (const [sitePath, hash] of site.files) {
  const ours = built.get(sitePath);
  if (ours === undefined) unchecked.push(sitePath);
  else if (ours === hash) matched++;
  else mismatched.push(sitePath);
}
const extra = [...built.keys()].filter((p) => !site.files.has(p));

log("");
log(`${matched} files match`);
if (unchecked.length) log(`${unchecked.length} deployed files are not produced by npm run build (not checked):\n  ${unchecked.join("\n  ")}`);
if (extra.length) log(`${extra.length} built files are not in the manifest:\n  ${extra.join("\n  ")}`);
if (mismatched.length) log(`${mismatched.length} files DIFFER:\n  ${mismatched.join("\n  ")}`);

if (workdir) {
  if (keep) log(`\ncheckout kept at ${workdir}`);
  else run("git", ["-C", root, "worktree", "remove", "--force", workdir]);
}

if (mismatched.length || matched === 0) {
  log("\nNOT VERIFIED: the deployed site is not what this commit builds.");
  process.exit(1);
}
log(`\nVERIFIED: every built file of the deployed site matches ${info.commit}.`);
