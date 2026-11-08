/**
 * Checks out one commit of a flathub ref, verified against flathub's signing
 * key, for comparing a Flatpak's BaseApp files with what flathub published.
 *
 * Usage: node fetch-flathub.mjs <ref> <commit> <outdir>   (inside scripts/reproduce's desktop image)
 *
 * Through a local forwarding proxy because flathub's CDN refuses libostree's
 * own user agent. The proxy only moves bytes: ostree still checks the commit's
 * GPG signature against /etc/flathub.gpg and every object against its checksum.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const [ref, commit, out] = process.argv.slice(2);
if (!ref || !/^[0-9a-f]{64}$/.test(commit ?? "") || !out) {
  console.error("usage: fetch-flathub.mjs <ref> <commit> <outdir>");
  process.exit(2);
}

const server = http.createServer(async (req, res) => {
  try {
    const upstream = await fetch(`https://dl.flathub.org${req.url}`, { headers: { "user-agent": "armada-verify-build" } });
    res.writeHead(upstream.status);
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    res.writeHead(502);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "flathub-"));
const ostree = (...args) => new Promise((resolve, reject) => {
  // Async, so the proxy in this process keeps serving while ostree runs.
  import("node:child_process").then(({ execFile }) =>
    execFile("ostree", [`--repo=${repo}`, ...args], { maxBuffer: 1 << 26 }, (error, stdout, stderr) =>
      error ? reject(new Error(`ostree ${args[0]}: ${stderr || error.message}`)) : resolve(stdout)));
});
try {
  execFileSync("ostree", ["init", `--repo=${repo}`, "--mode=bare-user-only"]);
  await ostree("remote", "add", "--gpg-import=/etc/flathub.gpg", "flathub", `http://127.0.0.1:${port}/repo/`);
  await ostree("pull", "--disable-static-deltas", "flathub", `${ref}@${commit}`);
  await ostree("checkout", "-U", commit, out);
} finally {
  server.close();
  fs.rmSync(repo, { recursive: true, force: true });
}
