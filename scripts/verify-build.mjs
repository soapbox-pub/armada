#!/usr/bin/env node
/**
 * Rebuilds a published Armada build from source and checks it file by file:
 * the live web app (the nsite, which browsers, the nsite gateways and every
 * desktop edition run), a release APK, or a desktop installer.
 *
 * Usage:
 *   node scripts/verify-build.mjs                    the live site, from the release relays
 *   node scripts/verify-build.mjs --manifest e.json  a specific kind-35128 site manifest
 *   node scripts/verify-build.mjs --apk Armada-vX.Y.Z.apk
 *   node scripts/verify-build.mjs --desktop Armada-vX.Y.Z.AppImage [--desktop …]
 *                                       (.deb, .flatpak, .exe, -portable.exe, -mac-x64.zip, -mac-arm64.zip;
 *                                        several artifacts of one release share one rebuild)
 *
 *   --tag vX.Y.Z    the release tag, when the file name doesn't carry it
 *   --no-container  (site, APK) build with this machine's tools instead of scripts/reproduce/Dockerfile
 *   --dist <dir>    (site) compare a build you already made, without rebuilding
 *   --keep          leave the checkout for inspection
 *
 * Every build carries a `build.json` (written by vite.config.ts) naming its
 * commit, build epoch, deployment config and toolchain: the site's is a file in
 * the signed manifest, the APK's is `assets/public/build.json`, a desktop app's
 * is `dist/build.json` inside its `app.asar`. The verifier fetches that commit
 * into a fresh shallow clone — what CI checks out — runs CI's build steps with
 * exactly those inputs inside the pinned toolchain image, and compares.
 *
 * What is compared is CONTENT, not container bytes:
 *   - an APK entry by entry, without its v1 signature files (the signature is
 *     the publisher's, and the v2/v3 signing block is not an entry at all);
 *   - a desktop artifact as the tree it unpacks to (scripts/verify/extract.sh),
 *     the NSIS payload's inner 7z included, against the same tree of the
 *     rebuilt artifact. A Flatpak is the rebuilt AppImage's files under
 *     /app/armada plus the BaseApp, which is compared with the commit flathub
 *     signed (scripts/verify/fetch-flathub.mjs); the files flatpak-builder
 *     generates are listed, and the sandbox permissions are checked against
 *     the manifest in the repo.
 * Site files the deploy adds after `npm run build` (spellcheck dictionaries,
 * the legacy `/downloads` archive) are listed as not checked rather than passed.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

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
const desktopFiles = args.flatMap((arg, i) => (args[i - 1] === "--desktop" ? [arg] : []));

/** What reaches a container build besides the recorded config. */
const BUILD_ENV = ["SOURCE_DATE_EPOCH", "CI_COMMIT_TAG", "WEBXDC_RT_REQUIRED"];

/**
 * Checkouts and the containers' HOME live on disk, not in os.tmpdir(): a
 * desktop rebuild needs several GB, and /tmp is often a small tmpfs. HOME
 * persists between runs as a download cache (npm, Electron, electron-builder,
 * Go modules), all of which are checked against hashes when used.
 */
const cacheDir = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "armada-verify");
const containerHome = path.join(cacheDir, "home");

const log = (message) => console.log(message);
const fail = (message) => {
  console.error(`verify-build: ${message}`);
  process.exit(1);
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const run = (command, argv, options = {}) => execFileSync(command, argv, { stdio: "inherit", ...options });

function image(stage) {
  const name = `armada-reproduce:${stage}`;
  run("docker", ["build", "-q", "--target", stage, "-t", name, path.join(root, "scripts/reproduce")], { stdio: ["ignore", "ignore", "inherit"] });
  return name;
}

/** Runs `script` in the reproduction image as this user, with `mounts` as [host, container] pairs. */
function inContainer(stage, script, { mounts = [], env = {}, workdir } = {}) {
  fs.mkdirSync(containerHome, { recursive: true });
  run("docker", [
    "run", "--rm",
    "-u", `${process.getuid()}:${process.getgid()}`,
    "-e", "HOME=/tmp/home",
    // Go marks its module cache read-only, which a later cleanup can't delete.
    "-e", "GOFLAGS=-modcacherw",
    ...Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
    "-v", `${containerHome}:/tmp/home:z`,
    ...mounts.flatMap(([host, inside]) => ["-v", `${host}:${inside}`]),
    ...(workdir ? ["-w", workdir] : []),
    image(stage), "bash", "-euc", script,
  ]);
}

// ── Reading what was published ───────────────────────────────────────────────

/** `{ path → sha256 }` of the live site, and its build.json. */
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

function releaseTag(file) {
  const tag = option("--tag") ?? path.basename(file).match(/v\d+\.\d+\.\d+/)?.[0];
  if (!tag) fail("pass --tag vX.Y.Z: the release tag is part of what the build stamps in");
  return tag;
}

function loadApk() {
  const entries = unzipSync(fs.readFileSync(apkFile), { filter: (f) => f.name === "assets/public/build.json" });
  const bytes = entries["assets/public/build.json"];
  if (!bytes) fail("the APK has no assets/public/build.json, so it does not say which commit it was built from");
  return { files: apkEntries(apkFile), info: JSON.parse(Buffer.from(bytes).toString("utf8")), tag: releaseTag(apkFile) };
}

/** Which artifact a desktop file is, from its name as the release names it. */
function desktopKind(file) {
  const name = path.basename(file);
  if (/\.AppImage$/i.test(name)) return { kind: "appimage", ext: "AppImage" };
  if (/\.deb$/i.test(name)) return { kind: "deb", ext: "deb" };
  if (/\.flatpak$/i.test(name)) return { kind: "flatpak", ext: "flatpak" };
  if (/-portable\.exe$/i.test(name)) return { kind: "portable", ext: "exe" };
  if (/\.exe$/i.test(name)) return { kind: "nsis", ext: "exe" };
  const mac = name.match(/-mac-(x64|arm64)\.zip$/i);
  if (mac) return { kind: "mac", arch: mac[1], ext: "zip" };
  fail(`not a desktop artifact this can rebuild: ${name}`);
}

/** Unpacks a desktop artifact into `out` with scripts/verify/extract.sh. */
function extract(artifact, out) {
  const kind = desktopKind(artifact);
  // A copy beside the output, so the one relabelled for the container (SELinux
  // denies mmap on an unlabelled bind mount) is ours, never the user's file.
  fs.mkdirSync(path.join(out, "in"), { recursive: true });
  fs.copyFileSync(artifact, path.join(out, "in", `a.${kind.ext}`));
  inContainer("desktop", `/v/extract.sh "/out/in/a.${kind.ext}" /out/tree && rm -r /out/in`, {
    mounts: [[out, "/out:z"], [path.join(root, "scripts/verify"), "/v:ro"]],
  });
  return path.join(out, "tree");
}

/** One file out of an asar archive (Electron's format: a pickled JSON header, then the data). */
function readAsarFile(asar, filePath) {
  const fd = fs.openSync(asar, "r");
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const headerSize = head.readUInt32LE(4);
    const jsonSize = head.readUInt32LE(12);
    const json = Buffer.alloc(jsonSize);
    fs.readSync(fd, json, 0, jsonSize, 16);
    let node = JSON.parse(json.toString("utf8"));
    for (const part of filePath.split("/")) node = node?.files?.[part];
    if (!node || node.unpacked || node.offset === undefined) return undefined;
    const bytes = Buffer.alloc(node.size);
    fs.readSync(fd, bytes, 0, node.size, 8 + headerSize + Number(node.offset));
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Every file of a tree: sha256 of its content, or a symlink's target. With
 * `gunzip`, a .gz is hashed decompressed: gzip stamps a time into its header.
 */
function tree(dir, { gunzip = false } = {}, prefix = "", files = new Map()) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) files.set(name, `link:${fs.readlinkSync(full)}`);
    else if (entry.isDirectory()) tree(full, { gunzip }, name, files);
    else {
      let bytes = fs.readFileSync(full);
      if (gunzip && name.endsWith(".gz")) bytes = zlib.gunzipSync(bytes);
      files.set(name, sha256(bytes));
    }
  }
  return files;
}

function loadDesktop(file, scratch) {
  const kind = desktopKind(file);
  const published = extract(file, scratch);
  const files = tree(published, { gunzip: true });
  const asar = [...files.keys()].find((name) => /(^|\/)resources\/app\.asar$/i.test(name));
  const bytes = asar && readAsarFile(path.join(published, asar), "dist/build.json");
  if (!bytes) fail(`${path.basename(file)} has no dist/build.json in its app.asar, so it does not say which commit it was built from`);
  return { file, name: path.basename(file), files, published, kind, info: JSON.parse(bytes.toString("utf8")), tag: releaseTag(file) };
}

// ── Rebuilding ───────────────────────────────────────────────────────────────

/** This shell's environment with only the recorded config reaching the build. */
function buildEnv(checkout, info) {
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

const versionOf = (tag) => tag.replace(/^v/, "");

/** The android job of .ngit/act/workflows/release.yml, minus signing. */
function apkBuildScript(tag) {
  const name = versionOf(tag);
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

/** The desktop job of .ngit/act/workflows/release.yml, up to the artifacts `kinds` need. */
function desktopBuildScript(tag, kinds) {
  const steps = [
    "npm ci --no-audit --no-fund",
    "npm run build:wasm",
    "npx vite build",
    "cp dist/index.html dist/404.html",
    "mkdir -p electron/dist && find electron/dist -mindepth 1 -delete && cp -rT dist electron/dist",
    "npx vite build -c vite.config.electron.ts",
    "npx vite build -c vite.config.electron-update.ts",
    "cd electron",
    `sed -i 's/"version": "[^"]*"/"version": "${versionOf(tag)}"/' package.json`,
    "npm ci --no-audit --no-fund",
    "./scripts/build-hevc-publisher.sh --arch x64",
    // electron-builder fetches its tools from GitHub releases, which fail
    // transiently; what it fetched is cached in HOME and hash-checked.
    "built=; for attempt in 1 2 3; do npx electron-builder --linux --win --config electron-builder.yml --publish never && { built=1; break; }; sleep 15; done",
    'test -n "$built"',
  ];
  const arches = [...new Set(kinds.filter((k) => k.kind === "mac").map((k) => k.arch))];
  if (arches.length) {
    steps.push(`node scripts/package-mac.mjs --arch=${arches.join(",")}`);
    for (const arch of arches) {
      steps.push(
        `(cd release/mac/Armada-darwin-${arch} && rcodesign --config-file /dev/null sign Armada.app >/dev/null && zip -qry ../Armada-mac-${arch}.zip Armada.app)`,
      );
    }
  }
  return steps.join(" && ");
}

/** The artifact of `kind` the desktop build produced, under `electron/`. */
function rebuiltDesktop(checkout, kind) {
  const release = path.join(checkout, "electron/release");
  const names = fs.readdirSync(release);
  const pick = (test) => {
    const name = names.find(test);
    if (!name) fail(`the rebuild produced no ${kind.kind} artifact in electron/release`);
    return path.join(release, name);
  };
  switch (kind.kind) {
    case "appimage":
    case "flatpak":
      return pick((n) => /^Armada-.*-linux-.*\.AppImage$/.test(n));
    case "deb":
      return pick((n) => n.endsWith(".deb"));
    case "nsis":
      return pick((n) => /-Setup\.exe$/.test(n));
    case "portable":
      return pick((n) => n.endsWith(".exe") && !/setup/i.test(n));
    case "mac":
      return path.join(release, `mac/Armada-mac-${kind.arch}.zip`);
  }
}

// ── The NSIS installer program ───────────────────────────────────────────────

/** NSIS 3's opcode for extracting a file; its 4th and 5th parameters are the file's FILETIME. */
const EW_EXTRACTFILE = 20;

/**
 * Compares two NSIS executables whole, not only the files they unpack: the
 * stub, the compiled installer script, and the data. The rebuild differs in
 * exactly two kinds of bytes — the build-time FILETIME NSIS records for each
 * file it packs, and the CRC32 trailer over everything — so those, and only
 * those, are allowed to differ. Returns what else differs.
 */
function compareNsis(publishedFile, rebuiltFile) {
  const parse = (file) => {
    const bytes = fs.readFileSync(file);
    const magic = Buffer.from("efbeadde4e756c6c736f6674496e7374", "hex");
    let at = -1;
    for (let o = 0; o + 32 <= bytes.length; o += 512) {
      if (bytes.subarray(o + 4, o + 20).equals(magic)) {
        at = o;
        break;
      }
    }
    if (at < 0) return undefined;
    const sizeWord = bytes.readUInt32LE(at + 28);
    // A separately compressed header; a solid installer has none to parse.
    if (!(sizeWord & 0x80000000)) return undefined;
    const size = sizeWord & 0x7fffffff;
    return {
      stub: bytes.subarray(0, at + 24),
      header: zlib.inflateRawSync(bytes.subarray(at + 32, at + 32 + size)),
      data: bytes.subarray(at + 32 + size, bytes.length - 4),
      archiveLength: bytes.readUInt32LE(at + 24) - size,
    };
  };
  const a = parse(publishedFile);
  const b = parse(rebuiltFile);
  if (!a || !b) return ["not an NSIS installer with a separately compressed header"];
  const problems = [];
  if (!a.stub.equals(b.stub)) problems.push("the installer stub differs");
  if (a.archiveLength !== b.archiveLength) problems.push("the installer's data length differs");
  if (!a.data.equals(b.data)) problems.push("the installer's packed data differs");
  if (a.header.length !== b.header.length) return [...problems, "the compiled installer script differs in length"];
  const entries = a.header.readUInt32LE(4 + 2 * 8);
  const entryCount = a.header.readUInt32LE(8 + 2 * 8);
  for (let i = 0; i < a.header.length; i += 4) {
    if (a.header.readUInt32LE(i) === b.header.readUInt32LE(i)) continue;
    const entry = Math.floor((i - entries) / 28);
    const word = ((i - entries) % 28) / 4;
    const isTime = i >= entries && entry < entryCount && (word === 4 || word === 5) &&
      a.header.readUInt32LE(entries + entry * 28) === EW_EXTRACTFILE &&
      b.header.readUInt32LE(entries + entry * 28) === EW_EXTRACTFILE;
    if (!isTime) {
      problems.push(`the compiled installer script differs at byte ${i}`);
      break;
    }
  }
  return problems;
}

// ── The Flatpak, from its parts ──────────────────────────────────────────────

/**
 * What the published Flatpak's files should be: the rebuilt AppImage under
 * files/armada with the venmic addon the manifest swaps in, the repo's own
 * wrapper/desktop/icon/metainfo, and the BaseApp commit flathub signed. Returns
 * the expected map and the paths flatpak-builder generates itself.
 */
function expectedFlatpak(target, checkout, scratch) {
  const appimage = tree(extract(rebuiltDesktop(checkout, target.kind), path.join(scratch, "rebuilt-appimage")), { gunzip: true });
  const expected = new Map();
  for (const [name, hash] of appimage) expected.set(`files/armada/${name}`, hash);

  const manifestYml = fs.readFileSync(path.join(checkout, "electron/flatpak/buzz.armada.app.yml"), "utf8");
  const venmic = manifestYml.match(/url: (https:\/\/registry\.npmjs\.org\/@vencord\/venmic\/[^\s]+)\s+sha256: ([0-9a-f]{64})/);
  if (!venmic) fail("could not find the venmic source in electron/flatpak/buzz.armada.app.yml");
  const tgz = path.join(scratch, "venmic.tgz");
  run("curl", ["-fsSL", "-o", tgz, venmic[1]]);
  if (sha256(fs.readFileSync(tgz)) !== venmic[2]) fail(`${venmic[1]} does not match the manifest's sha256`);
  const venmicDir = path.join(scratch, "venmic");
  fs.mkdirSync(venmicDir);
  run("tar", ["-xzf", tgz, "-C", venmicDir, "--strip-components=1"]);
  for (const [name, hash] of tree(path.join(venmicDir, "prebuilds"), { gunzip: true })) {
    expected.set(`files/armada/resources/app.asar.unpacked/node_modules/@vencord/venmic/prebuilds/${name}`, hash);
  }

  const repoFile = (file) => sha256(fs.readFileSync(path.join(checkout, file)));
  expected.set("files/bin/armada", repoFile("electron/flatpak/armada-wrapper"));
  for (const prefix of ["files", "export"]) {
    expected.set(`${prefix}/share/applications/buzz.armada.app.desktop`, repoFile("electron/flatpak/buzz.armada.app.desktop"));
    expected.set(`${prefix}/share/icons/hicolor/512x512/apps/buzz.armada.app.png`, repoFile("electron/build/linux-icon.png"));
  }
  // electron/flatpak/build.sh stages the metainfo with this release's <release>.
  const date = execFileSync("git", ["-C", checkout, "log", "-1", "--format=%cs"], { encoding: "utf8" }).trim();
  const metainfo = fs.readFileSync(path.join(checkout, "electron/flatpak/buzz.armada.app.metainfo.xml"), "utf8")
    .replace(/^<\/component>/m, `  <releases>\n    <release version="${versionOf(target.tag)}" date="${date}"/>\n  </releases>\n</component>`);
  for (const prefix of ["files", "export"]) expected.set(`${prefix}/share/metainfo/buzz.armada.app.metainfo.xml`, sha256(metainfo));
  expected.set("files/.ref", sha256(Buffer.alloc(0)));

  const appManifest = JSON.parse(fs.readFileSync(path.join(target.published, "files/manifest.json"), "utf8"));
  const baseRef = fs.readFileSync(path.join(target.published, "metadata"), "utf8").match(/^base=(.+)$/m)?.[1];
  if (!baseRef || !/^[0-9a-f]{64}$/.test(appManifest["base-commit"] ?? "")) fail("the Flatpak names no base and base commit");
  log(`BaseApp ${baseRef} @ ${appManifest["base-commit"]}, from flathub`);
  const baseOut = path.join(scratch, "base");
  fs.mkdirSync(baseOut);
  inContainer("desktop", `node /v/fetch-flathub.mjs "${baseRef}" "${appManifest["base-commit"]}" /out/tree`, {
    mounts: [[baseOut, "/out:z"], [path.join(root, "scripts/verify"), "/v:ro"]],
  });
  for (const [name, hash] of tree(path.join(baseOut, "tree"), { gunzip: true })) {
    if (!name.startsWith("files/")) continue;
    // The app's own manifest takes files/manifest.json; the base's moves aside.
    expected.set(name === "files/manifest.json" ? "files/manifest-base-1.json" : name, hash);
  }

  checkFlatpakPermissions(target.published, manifestYml);
  const generated = (name) =>
    name === "files/manifest.json" || name === "metadata" || name.startsWith("files/share/app-info/");
  return { expected, generated };
}

/** The sandbox the published Flatpak asks for must be exactly the manifest's finish-args. */
function checkFlatpakPermissions(published, manifestYml) {
  const block = manifestYml.match(/^finish-args:\n((?:\s+- .+\n)+)/m)?.[1] ?? "";
  const wanted = [...block.matchAll(/- (--[^\s]+)/g)].map((m) => m[1]).sort();
  const metadata = fs.readFileSync(path.join(published, "metadata"), "utf8");
  const section = (name) => metadata.match(new RegExp(`^\\[${name}\\]\\n([^[]*)`, "m"))?.[1] ?? "";
  const values = (name, key) => (section(name).match(new RegExp(`^${key}=(.*)$`, "m"))?.[1] ?? "").split(";").filter(Boolean);
  const pairs = (name) => section(name).split("\n").filter((line) => line.includes("=")).map((line) => line.split("="));
  const granted = [
    ...values("Context", "shared").map((v) => `--share=${v}`),
    ...values("Context", "sockets").map((v) => `--socket=${v}`),
    ...values("Context", "devices").map((v) => `--device=${v}`),
    ...values("Context", "filesystems").map((v) => `--filesystem=${v}`),
    ...pairs("Session Bus Policy").map(([bus, policy]) => `--${policy}-name=${bus}`),
    ...pairs("System Bus Policy").map(([bus, policy]) => `--system-${policy}-name=${bus}`),
    ...pairs("Environment").map(([name, value]) => `--env=${name}=${value}`),
  ].sort();
  if (JSON.stringify(granted) !== JSON.stringify(wanted)) {
    log(`the Flatpak's permissions:\n  ${granted.join("\n  ")}\nthe manifest's finish-args:\n  ${wanted.join("\n  ")}`);
    fail("the Flatpak's sandbox permissions are not the manifest's");
  }
  log(`sandbox permissions match the manifest (${granted.length} grants)`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

const desktop = desktopFiles.length > 0;
if (desktop && !useContainer) fail("--desktop needs the container: it unpacks installers with tools this machine may not have");
fs.mkdirSync(cacheDir, { recursive: true });
const scratch = fs.mkdtempSync(path.join(cacheDir, "run-"));
process.on("exit", () => {
  if (keep) log(`\nkept ${scratch}`);
  else fs.rmSync(scratch, { recursive: true, force: true });
});

const targets = desktop
  ? desktopFiles.map((file, i) => loadDesktop(file, path.join(scratch, `published-${i}`)))
  : [apkFile ? { ...loadApk(), name: path.basename(apkFile) } : { ...(await loadSite()), name: "the live site" }];
const { info, tag } = targets[0];
for (const other of targets) {
  if (other.info.commit !== info.commit || other.tag !== tag) {
    fail(`${other.name} is from ${other.info.commit} (${other.tag}), not ${info.commit} (${tag}): verify one release at a time`);
  }
}
if (!/^[0-9a-f]{40}$/.test(info.commit ?? "")) fail("build.json names no commit");
log(`built from ${info.commit}${info.tag ? ` (${info.tag})` : ""}, version ${info.version}, epoch ${info.sourceDateEpoch}`);

let checkout;
if (!prebuilt) {
  checkout = path.join(scratch, "src");
  // A shallow fetch of the one commit, as ngit-ci checks a build out: no tags,
  // no history, a real .git that the container can read.
  run("git", ["init", "-q", checkout]);
  run("git", ["-C", checkout, "-c", "protocol.version=2", "fetch", "-q", "--depth=1", `file://${root}`, info.commit]);
  run("git", ["-C", checkout, "checkout", "-q", "--detach", info.commit]);

  const env = buildEnv(checkout, info);
  const script = desktop
    ? desktopBuildScript(tag, targets.map((t) => t.kind))
    : apkFile ? apkBuildScript(tag) : "npm ci --no-audit --no-fund && npm run build";
  if (useContainer) {
    const stage = desktop ? "desktop" : apkFile ? "android" : "web";
    const passed = Object.keys(env).filter((name) => name in info.config || BUILD_ENV.includes(name));
    inContainer(stage, script, {
      env: Object.fromEntries(passed.map((name) => [name, env[name]])),
      mounts: [[checkout, "/src:z"]],
      workdir: "/src",
    });
  } else {
    warnToolchain(info);
    run("bash", ["-euc", script], { cwd: checkout, env });
  }
}

/** What `target` should contain, from the rebuild; and which of its files are generated metadata. */
function rebuilt(target, i) {
  if (prebuilt) return { expected: tree(path.resolve(prebuilt)) };
  if (target.kind?.kind === "flatpak") return expectedFlatpak(target, checkout, path.join(scratch, `expected-${i}`));
  if (target.kind) {
    const artifact = rebuiltDesktop(checkout, target.kind);
    if (sha256(fs.readFileSync(artifact)) === sha256(fs.readFileSync(target.file))) log(`${target.name}: the rebuilt artifact is byte-identical`);
    const problems = target.kind.ext === "exe" ? compareNsis(target.file, artifact) : [];
    if (target.kind.ext === "exe" && !problems.length) log(`${target.name}: the installer program matches, but for the times NSIS records`);
    return { expected: tree(extract(artifact, path.join(scratch, `rebuilt-${i}`)), { gunzip: true }), problems };
  }
  if (apkFile) return { expected: apkEntries(path.join(checkout, "android/app/build/outputs/apk/release/app-release-unsigned.apk")) };
  return { expected: tree(path.join(checkout, "dist")) };
}

function warnToolchain(recorded) {
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
    wasmBindgen: version("wasm-bindgen"),
    clang: version("clang"),
  };
  for (const [tool, used] of Object.entries(recorded.toolchain ?? {})) {
    if (tool !== "node" && !recorded.webxdcRt) continue;
    if (used !== local[tool]) log(`warning: built with ${tool} ${used}, you have ${local[tool] ?? "none"}`);
  }
}

// In an APK or an installer, a file nobody can account for is code nobody can account for.
const strict = Boolean(apkFile || desktop);
let failed = false;
targets.forEach((target, i) => {
  const { expected, generated = () => false, problems = [] } = rebuilt(target, i);
  const mismatched = [];
  const unchecked = [];
  const listedGenerated = [];
  let matched = 0;
  for (const [name, hash] of target.files) {
    const ours = expected.get(name);
    if (ours === undefined) (generated(name) ? listedGenerated : unchecked).push(name);
    else if (ours === hash) matched++;
    else mismatched.push(name);
  }
  const extra = [...expected.keys()].filter((name) => !target.files.has(name));

  log(`\n${target.name}: ${matched} files match`);
  if (listedGenerated.length) log(`${listedGenerated.length} files flatpak-builder generates (metadata, not compared):\n  ${listedGenerated.join("\n  ")}`);
  if (unchecked.length) log(`${unchecked.length} published files the rebuild did not produce (not checked):\n  ${unchecked.join("\n  ")}`);
  if (extra.length) log(`${extra.length} rebuilt files are not in the published build:\n  ${extra.join("\n  ")}`);
  if (mismatched.length) log(`${mismatched.length} files DIFFER:\n  ${mismatched.join("\n  ")}`);
  for (const problem of problems) log(problem);
  if (problems.length || mismatched.length || matched === 0 || (strict && (unchecked.length || extra.length))) {
    log(`NOT VERIFIED: ${target.name} is not what ${info.commit} builds.`);
    failed = true;
  } else {
    log(`VERIFIED: ${target.name} matches ${info.commit}.`);
  }
});
if (failed) process.exit(1);
