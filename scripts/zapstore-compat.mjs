#!/usr/bin/env node
/**
 * Re-sign a NIP-82 release's events so Zapstore's current client reads them.
 *
 * Run after `ngit release publish`. Zapstore (purplebase/models 0.3.5) has two
 * assumptions ngit's output breaks; both are fixed upstream but not shipped:
 *
 *   - `App.latestRelease` follows the app event's FIRST `a` tag as a legacy
 *     release pointer. ngit writes its NIP-34 repository coordinates (30617)
 *     there, so Zapstore finds no release and shows no notes. This re-signs the
 *     32267 with `a 30063:<pubkey>:<app>@<version>` first. ngit accepts and
 *     preserves that legacy tag, and its own link check reads the 30617s, which
 *     stay.
 *   - `App.latestAsset` installs the newest 3063 of the app with no platform
 *     filter, which is whichever desktop asset ngit signed last. This re-signs
 *     the release's APK asset with a later `created_at` than any other. ngit
 *     fetches assets only by the ids its release names, so the copy is
 *     invisible to it.
 *
 * relay.zapstore.dev also refuses every asset without `f android-arm64-v8a`,
 * and holds a release pending until it has every asset the release names, so
 * the NIP-82 release, which names the desktop builds too, is never listed.
 * This signs a copy naming only the APK asset and sends it to that relay
 * alone: the release is addressable, and anywhere else the copy would replace
 * the full one that /downloads, the desktop updater and npkg read.
 *
 * Idempotent: an event already in the wanted shape is left alone. The
 * Zapstore copy is signed again on every run, since a pending one can't be
 * seen; the newer copy supersedes it.
 *
 * Usage:
 *   node scripts/zapstore-compat.mjs --version 1.2.3 [--app buzz.armada.app]
 *   node scripts/zapstore-compat.mjs --version 1.2.3 --dry-run --pubkey <hex>
 *
 *   --dry-run prints the events it would sign and publishes nothing.
 *
 * Environment:
 *   NOSTR_BUNKER_URL, NOSTR_CLIENT_KEY  The NIP-46 session that owns the app,
 *                                       as for publish-release.mjs.
 *   RELAY_URLS                          Comma-separated. Default below.
 */

import process, { argv, env, exit, stderr } from 'node:process';

import { SimplePool } from 'nostr-tools/pool';
import { BunkerSigner, parseBunkerInput } from 'nostr-tools/nip46';
import { decode } from 'nostr-tools/nip19';
import { hexToBytes } from '@noble/hashes/utils';

const APP_KIND = 32267;
const RELEASE_KIND = 30063;
const ASSET_KIND = 3063;
const APK_MIME = 'application/vnd.android.package-archive';

const ZAPSTORE_RELAY = 'wss://relay.zapstore.dev';

/** Zapstore's catalog relay plus the publication relays of .ngit/release.yaml. */
const DEFAULT_RELAYS = [
  ZAPSTORE_RELAY,
  'wss://relay.ngit.dev',
  'wss://relay.ditto.pub',
  'wss://relay.dreamith.to',
  'wss://relay.primal.net',
];
const QUERY_WAIT_MS = 10_000;
const PUBLISH_TIMEOUT_MS = 30_000;

function parseArgs(args) {
  const opts = { app: 'buzz.armada.app' };
  for (let i = 0; i < args.length; i++) {
    const value = args[i + 1];
    if (args[i] === '--version') { opts.version = value?.replace(/^v/, ''); i++; }
    else if (args[i] === '--app') { opts.app = value; i++; }
    else if (args[i] === '--pubkey') { opts.pubkey = value; i++; }
    else if (args[i] === '--dry-run') opts.dryRun = true;
    else throw new Error(`unknown argument ${args[i]}`);
  }
  if (!opts.version) throw new Error('--version is required');
  if (opts.dryRun && !opts.pubkey) throw new Error('--dry-run needs --pubkey');
  return opts;
}

function parseSecretKey(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('nsec1')) {
    const { type, data } = decode(trimmed);
    if (type !== 'nsec') throw new Error(`expected an nsec, got ${type}`);
    return data;
  }
  if (!/^[0-9a-f]{64}$/i.test(trimmed)) throw new Error('client key must be an nsec or 64 hex characters');
  return hexToBytes(trimmed);
}

async function connectSigner() {
  const url = env.NOSTR_BUNKER_URL?.trim();
  const clientKey = env.NOSTR_CLIENT_KEY?.trim();
  if (!url) throw new Error('NOSTR_BUNKER_URL is not set');
  if (!clientKey) throw new Error('NOSTR_CLIENT_KEY is not set');
  const pointer = await parseBunkerInput(url);
  if (!pointer) throw new Error('could not parse NOSTR_BUNKER_URL');
  const signer = BunkerSigner.fromBunker(parseSecretKey(clientKey), pointer);
  await signer.connect();
  return signer;
}

function newest(events) {
  return events.reduce((a, b) => (!a || b.created_at > a.created_at ? b : a), undefined);
}

const tagValue = (event, name) => event.tags.find((t) => t[0] === name)?.[1];

/** Retried because ngit has only just published, and relays index asynchronously. */
async function queryUntil(pool, relays, filter, ok) {
  for (let attempt = 1; ; attempt++) {
    const events = await pool.querySync(relays, filter, { maxWait: QUERY_WAIT_MS });
    if (ok(events) || attempt === 4) return events;
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

async function publish(pool, relays, event, label) {
  if (!event.sig) {
    stderr.write(`${label} (dry run):\n${JSON.stringify(event, null, 2)}\n`);
    return;
  }
  const results = await Promise.allSettled(
    pool.publish(relays, event).map((p) =>
      Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), PUBLISH_TIMEOUT_MS))]),
    ),
  );
  results.forEach((r, i) => {
    if (r.status === 'rejected') stderr.write(`  warn ${relays[i]}: ${r.reason}\n`);
  });
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  stderr.write(`${label}: published ${event.id} to ${ok}/${relays.length} relay(s)\n`);
  if (!results[0] || results[0].status !== 'fulfilled') {
    throw new Error(`${relays[0]} did not accept the ${label}`);
  }
}

async function main() {
  const opts = parseArgs(argv.slice(2));
  const relays = (env.RELAY_URLS ? env.RELAY_URLS.split(',') : DEFAULT_RELAYS).map((s) => s.trim()).filter(Boolean);
  const signer = opts.dryRun
    ? { getPublicKey: async () => opts.pubkey, signEvent: async (t) => ({ ...t, pubkey: opts.pubkey }), close: async () => {} }
    : await connectSigner();
  const pool = new SimplePool();
  try {
    const pubkey = await signer.getPublicKey();
    stderr.write(`signing as ${pubkey}\n`);
    const now = Math.floor(Date.now() / 1000);

    const releaseD = `${opts.app}@${opts.version}`;
    // Not from Zapstore's relay, whose copy of the release names the APK alone.
    const release = newest(await queryUntil(pool, relays.filter((r) => r !== ZAPSTORE_RELAY),
      { kinds: [RELEASE_KIND], authors: [pubkey], '#d': [releaseD] }, (e) => e.length > 0));
    if (!release) throw new Error(`no release ${releaseD} found`);

    const assetIds = release.tags.filter((t) => t[0] === 'e').map((t) => t[1]);
    const assets = await queryUntil(pool, relays, { ids: assetIds },
      (e) => e.some((a) => tagValue(a, 'm') === APK_MIME));
    const apk = assets.find((a) => tagValue(a, 'm') === APK_MIME);
    if (!apk) throw new Error(`release ${releaseD} names no APK asset`);

    const others = await pool.querySync(relays,
      { kinds: [ASSET_KIND], authors: [pubkey], '#i': [opts.app], limit: 50 }, { maxWait: QUERY_WAIT_MS });
    const latest = newest(others);
    const apkIsNewest = latest && tagValue(latest, 'x') === tagValue(apk, 'x')
      && others.every((a) => a.id === latest.id || a.created_at < latest.created_at);
    let apkId = latest?.id;
    if (apkIsNewest) {
      stderr.write('asset: the APK is already the newest\n');
    } else {
      const event = await signer.signEvent({
        kind: ASSET_KIND,
        created_at: Math.max(now, (latest?.created_at ?? 0) + 1),
        content: apk.content,
        tags: apk.tags,
      });
      await publish(pool, relays, event, 'asset');
      apkId = event.id ?? '<asset id>';
    }

    if (relays.includes(ZAPSTORE_RELAY)) {
      const tags = release.tags.filter((t) => t[0] !== 'e' && (t[0] !== 'f' || t[1]?.startsWith('android-')));
      tags.push(['e', apkId]);
      const event = await signer.signEvent({
        kind: RELEASE_KIND,
        created_at: Math.max(now, release.created_at + 1),
        content: release.content,
        tags,
      });
      await publish(pool, [ZAPSTORE_RELAY], event, 'zapstore release');
    }

    const app = newest(await queryUntil(pool, relays,
      { kinds: [APP_KIND], authors: [pubkey], '#d': [opts.app] }, (e) => e.length > 0));
    if (!app) throw new Error(`no application ${opts.app} found`);
    const pointer = `${RELEASE_KIND}:${pubkey}:${releaseD}`;
    if (app.tags.find((t) => t[0] === 'a')?.[1] === pointer) {
      stderr.write('app: already points at the release\n');
    } else {
      const rest = app.tags.filter((t) => !(t[0] === 'a' && t[1]?.startsWith(`${RELEASE_KIND}:`)));
      const d = rest.findIndex((t) => t[0] === 'd');
      const tags = [...rest.slice(0, d + 1), ['a', pointer], ...rest.slice(d + 1)];
      const event = await signer.signEvent({
        kind: APP_KIND,
        created_at: Math.max(now, app.created_at + 1),
        content: app.content,
        tags,
      });
      await publish(pool, relays, event, 'app');
    }
  } finally {
    pool.close(relays);
    await signer.close().catch(() => {});
  }
}

main().then(
  () => { process.exitCode = 0; setTimeout(() => exit(0), 2_000).unref(); },
  (err) => { stderr.write(`error: ${err.message}\n`); process.exitCode = 1; setTimeout(() => exit(1), 2_000).unref(); },
);
