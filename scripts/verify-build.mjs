#!/usr/bin/env node
/**
 * Rebuilds a published Armada build from source and checks it file by file:
 * the live web app (the nsite, which browsers, the nsite gateways and every
 * desktop edition run), or a release APK.
 *
 * Usage:
 *   node scripts/verify-build.mjs                    the live site, from the release relays
 *   node scripts/verify-build.mjs --manifest e.json  a specific kind-35128 site manifest
 *   node scripts/verify-build.mjs --apk Armada-vX.Y.Z.apk [--tag vX.Y.Z]
 *
 *   --no-container  build with this machine's tools instead of scripts/reproduce/Dockerfile
 *   --dist <dir>    (site) compare a build you already made, without rebuilding
 *   --keep          leave the checkout for inspection
 *
 * Every build carries a `/build.json` (written by vite.config.ts) naming its
 * commit, build epoch, deployment config and toolchain: the site's is a file in
 * the signed manifest, the APK's is `assets/public/build.json`. The verifier
 * fetches that commit into a fresh shallow clone — what CI checks out — and
 * runs CI's build steps with exactly those inputs inside the pinned toolchain
 * image, then compares.
 *
 * An APK is compared entry by entry, without its v1 signature files: the
 * signature is the publisher's, not something a rebuild can produce, and the
 * v2/v3 signing block is not a zip entry at all. Site files the deploy adds
 * after `npm run build` (spellcheck dictionaries, the legacy `/downloads`
 * archive) are listed as not checked rather than passed.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { unzipSync } from "fflate";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const keep = args.includes("--keep");
const useContainer = !args.includes("--no-container");
const manifestFile = option("--manifest");
const prebuilt = option("--dist");
const apkFile = option("--apk");

/** What reaches a container build besides the recorded config. */
const BUILD_ENV = ["SOURCE_DATE_EPOCH", "CI_COMMIT_TAG", "WEBXDC_RT_REQUIRED"];

const log = (message) => console.log(message);
const fail = (message) => {
  console.error(`verify-build: ${message}`);
  process.exit(1);
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const run = (command, argv, options = {}) => execFileSync(command, argv, { stdio: "inherit", ...options });

/** `{ path → sha256 }` of what was published, and the build.json inside it. */
async function loadSite() {
  // Parsed by the same code the desktop shell trusts the manifest with.
  const feed = path.join(root, "electron/updateFeed.cjs");
  if (!fs.existsSync(feed)) run("npm", ["run", "-s", "build:electron-update"], { cwd: root });
  const { parseWebSite, resolveWebSite } = require(feed);

  const site = manifestFile
    ? parseWebSite(JSON.parse(fs.readFileSync(manifestFile, "utf8")))
    : await resolveWebSite();
  if (!site) fail("no site manifest signed by a release author was found");
  log(`manifest ${site.id} (${new Date(site.createdAt * 1000).toISOString()}), ${site.files.size} files`);

  const infoHash = site.files.get("/build.json");
  if (!infoHash) fail("the manifest has no /build.json, so it does not say which commit it was built from");
  let infoBytes;
  for (const server of site.servers) {
    try {
      const response = await fetch(`${server}/${infoHash}`, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) continue;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (sha256(bytes) === infoHash) {
        infoBytes = bytes;
        break;
      }
    } catch { /* next server */ }
  }
  if (!infoBytes) fail(`could not fetch /build.json (${infoHash}) from ${site.servers.join(", ")}`);
  return { files: site.files, info: JSON.parse(infoBytes.toString("utf8")) };
}

/** v1 signature files: META-INF/MANIFEST.MF and the signer's .SF and block files. */
const isSignatureEntry = (name) =>
  name === "META-INF/MANIFEST.MF" || /^META-INF\/[^/]+\.(SF|RSA|DSA|EC)$/i.test(name);

function apkEntries(file) {
  const entries = new Map();
  for (const [name, bytes] of Object.entries(unzipSync(fs.readFileSync(file)))) {
    if (!name.endsWith("/") && !isSignatureEntry(name)) entries.set(name, sha256(bytes));
  }
  return entries;
}

function loadApk() {
  const entries = unzipSync(fs.readFileSync(apkFile), { filter: (f) => f.name === "assets/public/build.json" });
  const bytes = entries["assets/public/build.json"];
  if (!bytes) fail("the APK has no assets/public/build.json, so it does not say which commit it was built from");
  const tag = option("--tag") ?? path.basename(apkFile).match(/v\d+\.\d+\.\d+/)?.[0];
  if (!tag) fail("pass --tag vX.Y.Z: the release tag sets the APK's versionName and versionCode");
  return { files: apkEntries(apkFile), info: JSON.parse(Buffer.from(bytes).toString("utf8")), tag };
}

const target = apkFile ? loadApk() : await loadSite();
const { info } = target;
if (!/^[0-9a-f]{40}$/.test(info.commit ?? "")) fail("build.json names no commit");
log(`built from ${info.commit}${info.tag ? ` (${info.tag})` : ""}, version ${info.version}, epoch ${info.sourceDateEpoch}`);

let workdir;
let built;
if (prebuilt) {
  built = walk(path.resolve(prebuilt));
} else {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "armada-verify-"));
  process.on("exit", () => {
    if (keep) log(`\ncheckout kept at ${workdir}`);
    else fs.rmSync(workdir, { recursive: true, force: true });
  });
  // A shallow fetch of the one commit, as ngit-ci checks a build out: no tags,
  // no history, a real .git that the container can read.
  run("git", ["init", "-q", workdir]);
  run("git", ["-C", workdir, "-c", "protocol.version=2", "fetch", "-q", "--depth=1", `file://${root}`, info.commit]);
  run("git", ["-C", workdir, "checkout", "-q", "--detach", info.commit]);

  const env = buildEnv(workdir);
  const script = apkFile ? apkBuildScript(target.tag) : "npm ci --no-audit --no-fund && npm run build";
  if (useContainer) {
    const stage = apkFile ? "android" : "web";
    const image = `armada-reproduce:${stage}`;
    run("docker", ["build", "-q", "--target", stage, "-t", image, path.join(root, "scripts/reproduce")]);
    const passed = Object.keys(env).filter((name) => name in info.config || BUILD_ENV.includes(name));
    run("docker", [
      "run", "--rm",
      "-u", `${process.getuid()}:${process.getgid()}`,
      "-e", "HOME=/tmp/home",
      ...passed.flatMap((name) => ["-e", `${name}=${env[name]}`]),
      "-v", `${workdir}:/src`,
      image, "bash", "-euc", script,
    ]);
  } else {
    warnToolchain();
    run("bash", ["-euc", script], { cwd: workdir, env });
  }
  built = apkFile
    ? apkEntries(path.join(workdir, "android/app/build/outputs/apk/release/app-release-unsigned.apk"))
    : walk(path.join(workdir, "dist"));
}

/** This shell's environment with only the recorded config reaching the build. */
function buildEnv(checkout) {
  const source = fs.readFileSync(path.join(checkout, "src/build/buildConfig.ts"), "utf8");
  const list = source.match(/CONFIG_NAMES = \[([\s\S]*?)\] as const/)?.[1] ?? "";
  const names = [...list.matchAll(/^\s*"([A-Z0-9_]+)",/gm)].map((m) => m[1]);
  const env = { ...process.env };
  for (const name of names) {
    delete env[name];
    delete env[`VITE_${name}`];
  }
  delete env.CI_COMMIT_SHORT_SHA;
  return Object.assign(env, info.config, {
    SOURCE_DATE_EPOCH: String(info.sourceDateEpoch),
    CI_COMMIT_TAG: info.tag ?? "",
    WEBXDC_RT_REQUIRED: info.webxdcRt ? "1" : "0",
  });
}

/** The android job of .ngit/act/workflows/release.yml, minus signing. */
function apkBuildScript(tag) {
  const name = tag.replace(/^v/, "");
  const [major, minor, patch] = name.split(".").map(Number);
  const code = major * 1_000_000 + minor * 1_000 + patch;
  return [
    "npm ci --no-audit --no-fund",
    "npm run build:wasm",
    "npx vite build",
    "cp dist/index.html dist/404.html",
    "npx cap sync android",
    `sed -i "s/versionCode [0-9]*/versionCode ${code}/" android/app/build.gradle`,
    `sed -i 's/versionName "[^"]*"/versionName "${name}"/' android/app/build.gradle`,
    "cd android && chmod +x gradlew && ./gradlew --no-daemon -q assembleRelease -PapkAbis=armeabi-v7a,arm64-v8a",
  ].join(" && ");
}

function warnToolchain() {
  const version = (command, cwd = root) => {
    try {
      return execFileSync(command, ["--version"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n")[0].trim();
    } catch {
      return null;
    }
  };
  const local = {
    node: process.version,
    rustc: version("rustc", path.join(root, "crates/webxdc-rt")),
    wasmPack: version("wasm-pack"),
    clang: version("clang"),
  };
  for (const [tool, recorded] of Object.entries(info.toolchain ?? {})) {
    if (tool !== "node" && !info.webxdcRt) continue;
    if (recorded !== local[tool]) log(`warning: built with ${tool} ${recorded}, you have ${local[tool] ?? "none"}`);
  }
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

const mismatched = [];
const unchecked = [];
let matched = 0;
for (const [name, hash] of target.files) {
  const ours = built.get(name);
  if (ours === undefined) unchecked.push(name);
  else if (ours === hash) matched++;
  else mismatched.push(name);
}
const extra = [...built.keys()].filter((name) => !target.files.has(name));

log("");
log(`${matched} files match`);
if (unchecked.length) log(`${unchecked.length} published files the rebuild did not produce (not checked):\n  ${unchecked.join("\n  ")}`);
if (extra.length) log(`${extra.length} rebuilt files are not in the published build:\n  ${extra.join("\n  ")}`);
if (mismatched.length) log(`${mismatched.length} files DIFFER:\n  ${mismatched.join("\n  ")}`);

// An APK entry missing from the rebuild is code nobody can account for.
if (mismatched.length || matched === 0 || (apkFile && (unchecked.length || extra.length))) {
  log("\nNOT VERIFIED: the published build is not what this commit builds.");
  process.exit(1);
}
log(`\nVERIFIED: every rebuilt file matches ${info.commit}.`);
