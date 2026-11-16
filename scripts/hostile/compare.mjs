#!/usr/bin/env node
/**
 * One hostile-network run of the role-toggle scenario (scripts/hostile/README.md).
 *
 * A Vector owner creates a Community with N Private Channels and Roles, then goes
 * offline. A HOLDER (Manage Channels, reads every Channel) is the only party left
 * holding the keys; a GRANTER (Manage Roles, reads none) toggles the MEMBER's Role.
 * Holder and member are the clients under test; the owner and granter are always
 * Vector, so both stacks face the same actions. Relays turn hostile after setup.
 *
 * Measured: time for the holder to be keyed at setup; after each "off", whether the
 * member can still read what the holder now writes (a leak); after the final "on",
 * time for the member to hold every Channel at the holder's epoch, through the
 * faults and then after they heal; and the epochs each Channel moved through.
 *
 * Usage: node scripts/hostile/compare.mjs --stack vector|armada|mixed-a-holder|mixed-a-member
 *          [--set hostile] [--channels 4] [--toggles on,off,on,off,on] [--gap 4000]
 *          [--deadline 300000] [--heal 180000] [--out results.jsonl]
 * Needs relay.mjs on --control (default 7100) and, for Armada, `npm run dev -- --port 8181`.
 */
import { appendFileSync } from "node:fs";
import { chromium } from "playwright";
import { generateSecretKey } from "nostr-tools/pure";

import { ArmadaClient, VectorClient } from "./clients.mjs";
import { SETS } from "./profiles.mjs";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const STACK = args.stack ?? "vector";
const SET = args.set ?? "hostile";
const K = Number(args.channels ?? 4);
const TOGGLES = (args.toggles ?? "on,off,on,off,on").split(",");
const GAP = Number(args.gap ?? 4000);
const DEADLINE = Number(args.deadline ?? 300_000);
const HEAL = Number(args.heal ?? 180_000);
const CONTROL = `http://localhost:${args.control ?? 7100}`;
const ORIGIN = args.origin ?? "http://localhost:8181";
const COMMUNITY_RELAYS = [1, 2, 3].map((i) => `wss://localhost:${Number(args.control ?? 7100) + i}`);
const ACCOUNT_RELAY = `wss://localhost:${Number(args.control ?? 7100) + 4}`;

// Who toggles the Role: a Vector admin, or an Armada one through Armada's own UI.
const ADMIN = args.admin ?? "vector";
const kinds = { vector: ["vector", "vector"], armada: ["armada", "armada"], "mixed-a-holder": ["armada", "vector"], "mixed-a-member": ["vector", "armada"] }[STACK];
if (!kinds) throw new Error(`no stack ${STACK}`);

const t0 = Date.now();
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 23)} +${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const post = (path, body) => fetch(CONTROL + path, { method: "POST", body: JSON.stringify(body ?? {}) }).then((r) => r.json());
const profiles = async (set) => {
  for (const [i, p] of set.entries()) await post("/profile", { relay: i, profile: p });
};

let browser;
const make = async (kind, name) => {
  const sk = generateSecretKey();
  if (kind === "vector") return new VectorClient(name, sk, "/tmp/hostile/data");
  browser ??= await chromium.launch({ channel: "chromium", args: ["--ignore-certificate-errors"] });
  return new ArmadaClient(name, sk, browser, ORIGIN, [ACCOUNT_RELAY]);
};

async function retry(what, fn, tries = 10) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries) throw e;
      log(`${what} failed (${e.message}); again`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

/** Poll until `done()` or the deadline; the elapsed ms, or null. */
async function until(done, deadlineMs, everyMs = 1500) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (await done().catch(() => false)) return Date.now() - start;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return null;
}

const result = { stack: STACK, admin: ADMIN, set: SET, channels: K, toggles: TOGGLES.join(","), gapMs: GAP, at: new Date().toISOString() };
const clients = [];
try {
  await post("/reset");
  await profiles(SETS.calm);

  const owner = await make("vector", "owner");
  const granter = await make(ADMIN, `granter-${ADMIN}`);
  const holder = await make(kinds[0], `holder-${kinds[0]}`);
  const member = await make(kinds[1], `member-${kinds[1]}`);
  clients.push(owner, granter, holder, member);
  for (const c of clients) await c.start();
  log(`clients up: holder=${kinds[0]} member=${kinds[1]}`);

  // The admin as in the incident: manages Roles and Channels, reads none of these Channels.
  const made = await owner.call("create", { name: `Hostile ${STACK}`, relays: COMMUNITY_RELAYS, channels: K, granterPermissions: 3 });
  const community = made.community;
  log(`community ${community.slice(0, 8)} with ${made.channels.length} private channels`);
  for (const c of [granter, holder, member]) await retry(`${c.name} join`, () => c.join(made.invite));
  await owner.call("roles", { community, npub: holder.npub, roles: ["Holder"] });
  await owner.call("roles", { community, npub: granter.npub, roles: ["Granter"] });

  // The granter acts on its own fold, so it must hold its Grant before the relays turn.
  const MANAGE_ROLES = 1n;
  if (granter.holdsWriteKey) {
    // An Armada admin acts once it holds the staff write key its Grant carries.
    result.granterReadyMs = await until(() => granter.holdsWriteKey(community), 30_000);
    if (result.granterReadyMs === null) {
      // The Vector owner sometimes reports its setup Grants written while no client ever
      // reads them; writing them again (after a restart) gets them out.
      log("the admin's Grant never arrived; the owner writes the Roles again");
      result.setupGrantsRetried = true;
      await owner.restart?.();
      await retry("owner roles", () => owner.call("roles", { community, npub: holder.npub, roles: ["Holder"] }));
      await retry("owner roles", () => owner.call("roles", { community, npub: granter.npub, roles: ["Granter"] }));
      result.granterReadyMs = await until(() => granter.holdsWriteKey(community), 150_000);
    }
    if (result.granterReadyMs === null) throw new Error("the Armada admin never took the write key its Grant carried");
  }
  if (granter.call) {
    result.granterReadyMs = await until(async () => (BigInt((await granter.call("can", { community, npub: granter.npub })).permissions) & MANAGE_ROLES) !== 0n, 120_000);
    if (result.granterReadyMs === null) throw new Error("the granter never folded its own Grant");
  }
  const keyed = async (c) => (await c.channels(community)).filter((ch) => ch.key && made.channels.includes(ch.id));
  result.holderKeyedMs = await until(async () => (await keyed(holder)).length === K, 45_000);
  if (result.holderKeyedMs === null) {
    // Vector only: its catch-up Direct Invite rides the Community's relays, which its gift-wrap
    // subscription never covers; the owner's own Grant runs its access duty only when it reads
    // back as an authority change; and a member reads access planes on a follow pass, which
    // nothing triggers after the one 20 s later. A new owner process owes a duty pass at once,
    // and a new holder process a read. Setup only, and recorded.
    result.setupNudged = true;
    await owner.restart?.();
    await new Promise((r) => setTimeout(r, 25_000));
    await holder.restart?.();
    result.holderKeyedMs = await until(async () => (await keyed(holder)).length === K, 110_000);
    if (result.holderKeyedMs !== null) result.holderKeyedMs += 70_000;
  }
  log(`holder keyed: ${result.holderKeyedMs ?? "NEVER"} ms`);
  if (result.holderKeyedMs === null) throw new Error("the holder never got the keys; nothing to compare");
  const epochsAtStart = Object.fromEntries((await keyed(holder)).map((c) => [c.id, c.epoch]));

  // An admin has the page open before they toggle: what it costs to load is not the toggle's.
  await granter.open?.(community, member.pubkey);
  // Only the holder can move keys from here.
  await owner.stop();
  await profiles(SETS[SET]);
  log(`relays now ${SET}; toggling ${TOGGLES.join(" → ")} every ${GAP} ms`);

  const holderKeys = async () => new Map((await keyed(holder)).map((c) => [c.id, c]));
  /** Whether a step has taken effect: on, the member holds every Channel at the holder's key; off, none. */
  const effective = async (on) => {
    const h = await holderKeys();
    const m = new Map((await keyed(member)).map((c) => [c.id, c]));
    if (h.size !== K) return false;
    return [...h.values()].every((c) => (m.get(c.id)?.key === c.key) === on);
  };
  const leaks = [];
  result.steps = [];
  for (const [i, step] of TOGGLES.entries()) {
    const on = step === "on";
    const began = Date.now();
    await retry(`toggle ${step}`, () =>
      granter.call ? granter.call("toggle", { community, npub: member.npub, role: "Verified", on }) : granter.toggle(community, member.pubkey, "Verified", on),
    granter.call ? 10 : 2);
    const clicked = Date.now() - began;
    // How long until the step took effect, within the gap; null when it didn't.
    const tookMs = await until(() => effective(on), Math.max(0, GAP - clicked), 500);
    result.steps.push({ step, clickedMs: clicked, effectiveMs: tookMs === null ? null : clicked + tookMs });
    log(`toggle ${i + 1}/${TOGGLES.length} ${step}: clicked ${clicked} ms, in effect ${tookMs === null ? `NOT within ${GAP} ms` : `${clicked + tookMs} ms`}`);
    if (!on && tookMs === null) leaks.push({ step: i + 1 });
    const left = GAP - (Date.now() - began);
    if (left > 0) await new Promise((r) => setTimeout(r, left));
  }
  const final = TOGGLES.at(-1) === "on";

  const converged = async () => {
    const h = await holderKeys();
    const m = new Map((await keyed(member)).map((c) => [c.id, c]));
    if (h.size !== K) return false;
    if (!final) return [...h.values()].every((c) => m.get(c.id)?.key !== c.key);
    return [...h.values()].every((c) => m.get(c.id)?.key === c.key);
  };
  result.convergedHostileMs = await until(converged, DEADLINE);
  log(`converged under ${SET}: ${result.convergedHostileMs ?? "NO"} (${DEADLINE} ms budget)`);
  if (result.convergedHostileMs === null) {
    await post("/heal");
    result.convergedHealedMs = await until(converged, HEAL);
    log(`after healing: ${result.convergedHealedMs ?? "STILL NO"}`);
  }
  const h = await holderKeys();
  const m = new Map((await keyed(member)).map((c) => [c.id, c]));
  result.memberHolds = [...h.values()].filter((c) => m.get(c.id)?.key === c.key).length;
  result.rotations = Object.fromEntries([...h.values()].map((c) => [c.id.slice(0, 8), c.epoch - (epochsAtStart[c.id] ?? 0)]));
  result.offToggles = TOGGLES.filter((s) => s === "off").length;
  result.leaks = leaks;
  result.relays = (await fetch(CONTROL + "/stats").then((r) => r.json())).map((r) => ({ events: r.events, lied: r.lied, refused: r.refused, withheld: r.withheld, disconnects: r.disconnects }));
  if (browser) result.armadaErrors = clients.filter((c) => c.errors?.length).map((c) => ({ [c.name]: c.errors.slice(0, 3) }));
} catch (e) {
  result.error = e.message;
  log("ERROR", e.message);
} finally {
  result.totalMs = Date.now() - t0;
  console.log(JSON.stringify(result));
  if (args.out) appendFileSync(args.out, JSON.stringify(result) + "\n");
  for (const c of clients) await c.stop().catch(() => {});
  await browser?.close();
  await profiles(SETS.calm).catch(() => {});
}
