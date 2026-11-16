/**
 * The two clients the hostile comparison drives (scripts/hostile/README.md):
 * `VectorClient`, one vector-sdk process (vector-driver), and `ArmadaClient`, the
 * Armada web app in a Chromium context. Both expose the same small surface — who
 * they are, join a link, and which Private Channel keys they hold — and neither is
 * told anything the network didn't tell it.
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getPublicKey } from "nostr-tools/pure";
import * as nip19 from "nostr-tools/nip19";

const HERE = dirname(fileURLToPath(import.meta.url));
const DRIVER = join(HERE, "vector-driver/target/debug/vector-driver");

export class VectorClient {
  constructor(name, sk, dataRoot) {
    this.name = name;
    this.sk = sk;
    this.pubkey = getPublicKey(sk);
    this.npub = nip19.npubEncode(this.pubkey);
    this.dir = join(dataRoot, name);
    this.pending = new Map();
    this.next = 1;
  }
  async start({ fresh = true } = {}) {
    if (fresh) rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
    this.proc = spawn(DRIVER, [], { env: { ...process.env, VECTOR_NSEC: nip19.nsecEncode(this.sk), VECTOR_DATA_DIR: this.dir, VECTOR_LOG: process.env.VECTOR_LOG ?? "info" }, stdio: ["pipe", "pipe", "pipe"] });
    const log = `/tmp/hostile/${this.name}.log`;
    if (fresh) writeFileSync(log, "");
    const t0 = Date.now();
    createInterface({ input: this.proc.stderr }).on("line", (line) => appendFileSync(log, `${new Date().toISOString().slice(11, 23)} ${line}\n`));
    const ready = new Promise((resolve) => (this.onReady = resolve));
    createInterface({ input: this.proc.stdout }).on("line", (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        appendFileSync(log, `${new Date().toISOString().slice(11, 23)} ${line}\n`);
        return;
      }
      if (msg.event === "ready") return this.onReady();
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.ok ? p.resolve(msg.result) : p.reject(new Error(`${this.name}: ${msg.error}`));
    });
    await ready;
  }
  call(cmd, args = {}, timeoutMs = 180_000) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name}: ${cmd} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(e)) });
      this.proc.stdin.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
    });
  }
  join(invite) {
    return this.call("join", { invite });
  }
  /** Private Channels as this client holds them: `{ id, key, epoch }`, key null when keyless. */
  async channels(community) {
    const s = await this.call("state", { community }, 30_000);
    return s.held ? s.channels : [];
  }
  async stop() {
    this.proc?.stdin.write(`${JSON.stringify({ cmd: "quit" })}\n`);
    this.proc?.kill("SIGTERM");
    await new Promise((r) => (this.proc && this.proc.exitCode === null ? this.proc.once("exit", r) : r()));
  }
  /** The same account and database, a new process: its subscriptions open again. */
  async restart() {
    await this.stop();
    await this.start({ fresh: false });
  }
}

export class ArmadaClient {
  constructor(name, sk, browser, origin, accountRelays) {
    this.name = name;
    this.sk = sk;
    this.pubkey = getPublicKey(sk);
    this.npub = nip19.npubEncode(this.pubkey);
    this.browser = browser;
    this.origin = origin;
    this.accountRelays = accountRelays;
  }
  async start() {
    writeFileSync(`/tmp/hostile/${this.name}.log`, "");
    this.context = await this.browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 860 } });
    const login = [{ id: `nsec:${this.pubkey}`, type: "nsec", pubkey: this.pubkey, createdAt: new Date().toISOString(), data: { nsec: nip19.nsecEncode(this.sk) } }];
    const config = {
      useAppRelays: false,
      automaticSettingsSync: false,
      dmRelays: this.accountRelays,
      relayMetadata: { relays: this.accountRelays.map((url) => ({ url, read: true, write: true })), updatedAt: Math.floor(Date.now() / 1000), pubkey: this.pubkey },
    };
    await this.context.addInitScript(
      ([loginJson, pubkey, configJson]) => {
        localStorage.setItem("armada:login", loginJson);
        localStorage.setItem("armada:active-pubkey", pubkey);
        localStorage.setItem("armada:webpush-prompt-shown", "1");
        localStorage.setItem(`armada:app-config:${pubkey}`, configJson);
      },
      [JSON.stringify(login), this.pubkey, JSON.stringify(config)],
    );
    this.page = await this.context.newPage();
    this.page.on("pageerror", (e) => (this.errors ??= []).push(String(e)));
    const t0 = Date.now();
    this.page.on("console", (m) => appendFileSync(`/tmp/hostile/${this.name}.log`, `${new Date().toISOString().slice(11, 23)} ${m.text()}\n`));
    await this.page.goto(this.origin + "/");
  }
  /** Join through the link as a person would: open it, press Join. */
  async join(invite) {
    const u = new URL(invite);
    await this.page.goto(`${this.origin}${u.pathname}${u.hash}`);
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const skip = this.page.getByText("Skip for now");
      if (await skip.isVisible().catch(() => false)) await skip.click({ force: true }).catch(() => {});
      const join = this.page.getByRole("button", { name: /^(join|accept invite)/i }).first();
      if (await join.isVisible().catch(() => false)) {
        await join.click().catch(() => {});
        await this.page.waitForTimeout(1000);
      }
      if (/\/(c|concord)\//.test(this.page.url())) return;
      await this.page.waitForTimeout(500);
    }
    await this.page.screenshot({ path: `/tmp/hostile/${this.name}-join.png` });
    throw new Error(`${this.name}: join never landed (${this.page.url()})`);
  }
  /**
   * Toggle a member's Role as a person does: the member's "Manage" menu in the member
   * list, then the Role's checkbox under Roles. Resolves once the click lands; the Grant and
   * the keys it moves are the app's to carry from there.
   */
  /** Open the Community with the member's row listed, as an admin about to toggle has it. */
  async open(community, memberPubkey) {
    const page = this.page;
    if (!page.url().includes(`/c/${community}`)) await page.goto(`${this.origin}/c/${community}`);
    await page.locator(".member-row").filter({ hasText: `#${memberPubkey.slice(-4)}` }).first().waitFor({ state: "attached", timeout: 60_000 }).catch(() => undefined);
  }
  async toggle(community, memberPubkey, roleName, on) {
    const page = this.page;
    if (!page.url().includes(`/c/${community}`)) await page.goto(`${this.origin}/c/${community}`);
    // An open menu hides the rest of the page from the accessibility tree: close any first.
    for (let i = 0; i < 4 && (await page.locator('[role="menu"]').count()) > 0; i++) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
    }
    // A profile-less row reads "Anonymous#abcd", the tag being the pubkey's last four hex.
    const row = page.locator(".member-row").filter({ hasText: `#${memberPubkey.slice(-4)}` }).first();
    const manage = row.getByRole("button", { name: /^Manage / }).first();
    try {
      await manage.waitFor({ state: "attached", timeout: 60_000 });
    } catch (e) {
      await page.screenshot({ path: `/tmp/hostile/${this.name}-toggle.png` });
      throw e;
    }
    await manage.click({ force: true });
    await page.getByRole("menuitem", { name: /^Roles$/ }).first().hover();
    const box = page.getByRole("menuitemcheckbox", { name: new RegExp(`^${roleName}`) }).first();
    await box.waitFor({ timeout: 15_000 });
    const deadline = Date.now() + 60_000;
    // Disabled while a toggle of this Role is still in flight.
    while ((await box.getAttribute("data-disabled")) !== null && Date.now() < deadline) await page.waitForTimeout(250);
    const checked = (await box.getAttribute("aria-checked")) === "true";
    if (checked !== on) await box.click();
    await page.waitForTimeout(500);
    for (let i = 0; i < 4 && (await page.locator('[role="menu"]').count()) > 0; i++) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
    }
  }
  /** Whether this client holds the Community's staff write key (CORD-02 §2), as it persisted it. */
  async holdsWriteKey(community) {
    return this.page.evaluate(
      async ([pk, cid]) => {
        const { readFolded } = await import("/src/lib/foldedCache.ts");
        const { communityListFoldKey } = await import("/src/concord/lib/communityList.ts");
        const entry = (await readFolded(communityListFoldKey(pk)))?.list?.entries?.find((e) => e.community_id === cid);
        return typeof entry?.current?.control_root === "string";
      },
      [this.pubkey, community],
    );
  }
  /** Private Channels as this client holds them, from the list it persisted. */
  async channels(community) {
    return this.page.evaluate(
      async ([pk, cid]) => {
        const { readFolded } = await import("/src/lib/foldedCache.ts");
        const { communityListFoldKey } = await import("/src/concord/lib/communityList.ts");
        const persisted = await readFolded(communityListFoldKey(pk));
        const entry = persisted?.list?.entries?.find((e) => e.community_id === cid);
        const cuts = new Map((entry?.channel_cuts ?? []).map((c) => [c.id, c.epoch]));
        return (entry?.current?.channels ?? []).filter((c) => !(cuts.get(c.id) > c.epoch)).map((c) => ({ id: c.id, key: c.key, epoch: c.epoch }));
      },
      [this.pubkey, community],
    );
  }
  async stop() {
    await this.context?.close();
  }
}
