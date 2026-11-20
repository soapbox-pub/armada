/// <reference lib="webworker" />

/**
 * Schnorr EC worker: verify `(sig, id, pubkey)` triples or sign `(hash, sk)`
 * jobs, and open NIP-44 payloads. Curve math and decryption ONLY — ids arrive
 * pre-hashed and bound on the main thread (`verifyCache.ts` `hashGate`), and
 * what a plaintext claims is checked there too.
 */

import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { decrypt as nip44Decrypt } from "nostr-tools/nip44";

import type { WorkerRequest, WorkerResponse } from "./verifyWorkerTypes";

/** Verify one triple. Any malformed hex reads as invalid, never as a throw. */
function verifyOne(sig: string, id: string, pubkey: string): boolean {
  try {
    return schnorr.verify(hexToBytes(sig), hexToBytes(id), hexToBytes(pubkey));
  } catch {
    return false;
  }
}

/** Sign one hash. A malformed key reads as `null`, never as a throw. */
function signOne(hash: string, sk: Uint8Array): string | null {
  try {
    return bytesToHex(schnorr.sign(hexToBytes(hash), sk));
  } catch {
    return null;
  }
}

/** Open one payload. A failed MAC or a bad key reads as `null`, never as a throw. */
function decryptOne(key: Uint8Array, payload: string): string | null {
  try {
    return nip44Decrypt(payload, key);
  } catch {
    return null;
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (request.op === "decrypt") {
    post({ id: request.id, results: request.jobs.map((job) => decryptOne(job.key, job.payload)) });
    return;
  }
  if (request.op === "sign") {
    post({ id: request.id, results: request.jobs.map((job) => signOne(job.hash, job.sk)) });
    return;
  }
  post({ id: request.id, results: request.triples.map((t) => verifyOne(t.sig, t.id, t.pubkey)) });
};

function post(response: WorkerResponse): void {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(response);
}
