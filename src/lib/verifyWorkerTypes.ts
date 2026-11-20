/**
 * Message contract between {@link verifyPool} and the EC worker; separate
 * module so the main thread doesn't bundle `@noble` via the worker. `sign`
 * jobs are pre-hashed NIP-42 stream-key AUTHs (`streamAuth.ts`); `decrypt` jobs
 * are the NIP-44 layers of Concord wraps (`stream.ts` `openWrapsBatched`).
 */

import type { VerifyTriple } from "./verifyCache";

/** A verify batch, tagged with a round id so replies can be matched up. */
export interface VerifyRequest {
  id: number;
  op: "verify";
  triples: VerifyTriple[];
}

/** One signature to produce: the 32-byte message (hex) and the secret key. */
export interface SignJob {
  hash: string;
  sk: Uint8Array;
}

/** A sign batch, tagged like a verify round. */
export interface SignRequest {
  id: number;
  op: "sign";
  jobs: SignJob[];
}

/** One NIP-44 payload to open under its conversation key. */
export interface DecryptJob {
  key: Uint8Array;
  payload: string;
}

/** A decrypt batch, tagged like a verify round. */
export interface DecryptRequest {
  id: number;
  op: "decrypt";
  jobs: DecryptJob[];
}

export type WorkerRequest = VerifyRequest | SignRequest | DecryptRequest;

/** One boolean per triple, in the request's order, tagged with its round id. */
export interface VerifyResponse {
  id: number;
  results: boolean[];
}

/** One hex signature per job; `null` = malformed key (no AUTH, never retried). */
export interface SignResponse {
  id: number;
  results: (string | null)[];
}

/** One plaintext per job; `null` where the payload doesn't open (a failed MAC, a bad key). */
export interface DecryptResponse {
  id: number;
  results: (string | null)[];
}

export type WorkerResponse = VerifyResponse | SignResponse | DecryptResponse;
