#!/usr/bin/env node
/**
 * Publish the NIP-C1 proof that links Armada's APK signing certificate to the
 * Nostr key that signs its releases (kind 30509), unless a valid one exists.
 *
 * relay.zapstore.dev holds APK listings "pending" until their checks pass and
 * warns that it will require this proof; without it our releases since 0.66.8
 * were accepted with OK and never stored. `zsp identity --link-key` makes the
 * same event, but only through its own NIP-46 session or an nsec, and refuses
 * to emit it unsigned, so this builds it as zsp does (internal/identity/x509.go)
 * and signs through the release workflow's existing session:
 *
 *   message   "Verifying at <created_at> until <expiry> that I control the
 *             following Nostr public key: <pubkey hex>"
 *   signature the certificate key over SHA-256(message): PKCS#1 v1.5 for RSA,
 *             ASN.1 for ECDSA; standard base64
 *   tags      d = SHA-256 of the certificate's DER (lowercase hex),
 *             signature, expiry; content empty; created_at the same instant
 *             the message names
 *
 * Idempotent: a proof for this key and certificate that verifies and has more
 * than RENEW_BEFORE_DAYS left is left alone, so this can run on every release.
 *
 * Refuses a keystore whose certificate isn't the one on the app's newest
 * published APK asset (`apk_certificate_hash`), so a wrong keystore can't link
 * an unrelated certificate to the release key.
 *
 * Usage:
 *   node scripts/zapstore-identity.mjs --keystore upload.p12 [--alias upload] [--app buzz.armada.app]
 *   node scripts/zapstore-identity.mjs --keystore upload.p12 --dry-run --pubkey <hex>
 *
 * Environment:
 *   KEYSTORE_PASSWORD                   The PKCS#12 store (and key) password.
 *   NOSTR_BUNKER_URL, NOSTR_CLIENT_KEY  The NIP-46 session that owns the app,
 *                                       as for zapstore-compat.mjs.
 *   RELAY_URLS                          Comma-separated. Default below.
 */

import { execFileSync } from 'node:child_process';
import { X509Certificate, createHash, createPrivateKey, sign, verify } from 'node:crypto';
import process, { argv, env, exit, stderr } from 'node:process';

import { SimplePool } from 'nostr-tools/pool';
import { BunkerSigner, parseBunkerInput } from 'nostr-tools/nip46';
import { decode } from 'nostr-tools/nip19';
import { verifyEvent } from 'nostr-tools/pure';
import { hexToBytes } from '@noble/hashes/utils';

const PROOF_KIND = 30509;
const ASSET_KIND = 3063;
const APK_MIME = 'application/vnd.android.package-archive';
/** zsp's DefaultExpiry. */
const VALIDITY_SECONDS = 2 * 365 * 24 * 60 * 60;
const RENEW_BEFORE_DAYS = 60;

/** Zapstore's relay first: it is the one that requires the proof. */
const DEFAULT_RELAYS = [
  'wss://relay.zapstore.dev',
  'wss://relay.ngit.dev',
  'wss://relay.ditto.pub',
  'wss://relay.primal.net',
];
const QUERY_WAIT_MS = 10_000;
const PUBLISH_TIMEOUT_MS = 30_000;

function parseArgs(args) {
  const opts = { alias: undefined, app: 'buzz.armada.app' };
  for (let i = 0; i < args.length; i++) {
    const value = args[i + 1];
    if (args[i] === '--keystore') { opts.keystore = value; i++; }
    else if (args[i] === '--alias') { opts.alias = value; i++; }
    else if (args[i] === '--app') { opts.app = value; i++; }
    else if (args[i] === '--pubkey') { opts.pubkey = value; i++; }
    else if (args[i] === '--dry-run') opts.dryRun = true;
    else throw new Error(`unknown argument ${args[i]}`);
  }
  if (!opts.keystore) throw new Error('--keystore is required');
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

/** The key and certificate out of a PKCS#12 store, read into memory by openssl. */
function readKeystore(path, alias) {
  if (!env.KEYSTORE_PASSWORD) throw new Error('KEYSTORE_PASSWORD is not set');
  const run = (extra) => execFileSync('openssl', [
    'pkcs12', '-in', path, '-passin', 'env:KEYSTORE_PASSWORD', '-nodes',
    ...(alias ? ['-name', alias] : []), ...extra,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const keyPem = run(['-nocerts']).match(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/)?.[0];
  const certPem = run(['-nokeys', '-clcerts']).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0];
  if (!keyPem || !certPem) throw new Error(`no key and certificate in ${path}`);
  const key = createPrivateKey(keyPem);
  const cert = new X509Certificate(certPem);
  if (!cert.checkPrivateKey(key)) throw new Error('the keystore key is not the certificate\'s key');
  return { key, cert };
}

const message = (createdAt, expiry, pubkey) =>
  `Verifying at ${createdAt} until ${expiry} that I control the following Nostr public key: ${pubkey}`;

const tagValue = (event, name) => event.tags.find((t) => t[0] === name)?.[1];

/** Whether `event` is a proof of `pubkey` for `cert` that zsp's ValidateActiveProofEvent would accept at `now`. */
function proofHolds(event, cert, certHash, pubkey, now) {
  if (event.kind !== PROOF_KIND || event.pubkey !== pubkey || event.content !== '' || !verifyEvent(event)) return false;
  if (tagValue(event, 'd') !== certHash || event.tags.some((t) => t[0] === 'revoked')) return false;
  const expiry = Number(tagValue(event, 'expiry'));
  if (!Number.isInteger(expiry) || expiry <= event.created_at || expiry <= now) return false;
  const signature = Buffer.from(tagValue(event, 'signature') ?? '', 'base64');
  return signature.length > 0 && verify('sha256', Buffer.from(message(event.created_at, expiry, pubkey)), cert.publicKey, signature);
}

async function publish(pool, relays, event) {
  if (!event.sig) {
    stderr.write(`proof (dry run):\n${JSON.stringify(event, null, 2)}\n`);
    return;
  }
  const results = await Promise.allSettled(
    pool.publish(relays, event).map((p) =>
      Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), PUBLISH_TIMEOUT_MS))]),
    ),
  );
  results.forEach((r, i) => {
    stderr.write(`  ${relays[i]}: ${r.status === 'fulfilled' ? r.value || 'ok' : `failed (${r.reason})`}\n`);
  });
  if (!results[0] || results[0].status !== 'fulfilled') {
    throw new Error(`${relays[0]} did not accept the proof`);
  }
}

async function main() {
  const opts = parseArgs(argv.slice(2));
  const relays = (env.RELAY_URLS ? env.RELAY_URLS.split(',') : DEFAULT_RELAYS).map((s) => s.trim()).filter(Boolean);
  const { key, cert } = readKeystore(opts.keystore, opts.alias);
  const certHash = createHash('sha256').update(cert.raw).digest('hex');
  stderr.write(`certificate ${certHash} (${cert.subject.replace(/\n/g, ', ')})\n`);

  const signer = opts.dryRun
    ? { getPublicKey: async () => opts.pubkey, signEvent: async (t) => ({ ...t, pubkey: opts.pubkey }), close: async () => {} }
    : await connectSigner();
  const pool = new SimplePool();
  try {
    const pubkey = await signer.getPublicKey();
    stderr.write(`signing as ${pubkey}\n`);
    const now = Math.floor(Date.now() / 1000);

    const apks = await pool.querySync(relays, { kinds: [ASSET_KIND], authors: [pubkey], '#i': [opts.app] }, { maxWait: QUERY_WAIT_MS });
    const apk = apks.filter((a) => tagValue(a, 'm') === APK_MIME).sort((a, b) => b.created_at - a.created_at)[0];
    const apkCert = apk && tagValue(apk, 'apk_certificate_hash')?.toLowerCase();
    if (!apkCert) {
      // Also how a session signing as the wrong key shows: it has published no APK.
      throw new Error(`${pubkey} has published no APK of ${opts.app} that names its certificate`);
    } else if (apkCert !== certHash) {
      throw new Error(`the keystore's certificate is not the one ${opts.app}'s APKs are signed with (${apkCert})`);
    }

    const existing = await pool.querySync(relays, { kinds: [PROOF_KIND], authors: [pubkey], '#d': [certHash] }, { maxWait: QUERY_WAIT_MS });
    const renewAfter = now + RENEW_BEFORE_DAYS * 24 * 60 * 60;
    const holding = existing.find((e) => proofHolds(e, cert, certHash, pubkey, renewAfter));
    if (holding) {
      stderr.write(`proof: ${holding.id} holds until ${new Date(Number(tagValue(holding, 'expiry')) * 1000).toISOString()}\n`);
      // Found on any relay, but the first is the one that has to store it.
      const stored = await pool.querySync([relays[0]], { ids: [holding.id] }, { maxWait: QUERY_WAIT_MS });
      if (stored.length > 0) return;
      stderr.write(`proof: missing from ${relays[0]}${opts.dryRun ? '' : ', re-sending it'}\n`);
      if (!opts.dryRun) await publish(pool, relays, holding);
      return;
    }

    const createdAt = Math.max(now, ...existing.map((e) => e.created_at + 1));
    const expiry = createdAt + VALIDITY_SECONDS;
    const signature = sign('sha256', Buffer.from(message(createdAt, expiry, pubkey)), key).toString('base64');
    const event = await signer.signEvent({
      kind: PROOF_KIND,
      created_at: createdAt,
      content: '',
      tags: [['d', certHash], ['signature', signature], ['expiry', String(expiry)]],
    });
    // The same check a reader makes, before anything leaves this machine.
    if (event.sig && !proofHolds(event, cert, certHash, pubkey, now)) throw new Error('the built proof does not verify');
    if (!verify('sha256', Buffer.from(message(createdAt, expiry, pubkey)), cert.publicKey, Buffer.from(signature, 'base64'))) {
      throw new Error('the certificate signature does not verify');
    }
    await publish(pool, relays, event);
  } finally {
    pool.close(relays);
    await signer.close().catch(() => {});
  }
}

main().then(
  () => { process.exitCode = 0; setTimeout(() => exit(0), 2_000).unref(); },
  (err) => { stderr.write(`error: ${err.message}\n`); process.exitCode = 1; setTimeout(() => exit(1), 2_000).unref(); },
);
