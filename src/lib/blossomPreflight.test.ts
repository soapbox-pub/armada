import { describe, expect, it, vi } from "vitest";

import {
  describeRefusal,
  encryptedUploadFailureReason,
  preflightRefusal,
  preflightUpload,
  uploadFailureReason,
  uploadTimeoutMs,
} from "./blossomPreflight";

function respond(status: number, reason?: string): Response {
  return new Response(null, { status, headers: reason ? { "X-Reason": reason } : {} });
}

describe("preflightUpload", () => {
  it("sends an unauthenticated HEAD /upload carrying the blob's size, type and hash", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => respond(200));
    const verdict = await preflightUpload(
      "https://blossom.example",
      { size: 1234, type: "video/mp4", sha256: "ab".repeat(32) },
      { fetch },
    );

    expect(verdict).toEqual({ kind: "accepted" });
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe("https://blossom.example/upload");
    expect(init?.method).toBe("HEAD");
    expect(init?.headers).toEqual({
      "X-Content-Length": "1234",
      "X-Content-Type": "video/mp4",
      "X-SHA-256": "ab".repeat(32),
    });
    expect(init?.headers).not.toHaveProperty("authorization");
  });

  it("reads a size, type or payment refusal with the server's reason", async () => {
    for (const status of [413, 415, 402]) {
      const verdict = await preflightUpload("https://b.example", { size: 1 }, { fetch: async () => respond(status, "nope") });
      expect(verdict).toEqual({ kind: "refused", status, reason: "nope" });
    }
  });

  it("treats no BUD-06, wanted auth, a missing-hash 400 and a network error as no answer", async () => {
    for (const status of [400, 401, 403, 404, 405, 500]) {
      expect(await preflightUpload("https://b.example", { size: 1 }, { fetch: async () => respond(status) })).toEqual({ kind: "unknown" });
    }
    const failing = async (): Promise<Response> => { throw new TypeError("offline"); };
    expect(await preflightUpload("https://b.example", { size: 1 }, { fetch: failing })).toEqual({ kind: "unknown" });
  });
});

describe("preflightRefusal", () => {
  const byHost = (answers: Record<string, Response>) =>
    async (input: RequestInfo | URL) => answers[new URL(String(input)).host];

  it("refuses only when every server refuses, since the upload takes the first that accepts", async () => {
    const some = await preflightRefusal(["https://a.example", "https://b.example"], { size: 1 }, {
      fetch: byHost({ "a.example": respond(413, "too big"), "b.example": respond(404) }),
    });
    expect(some).toBeUndefined();

    const all = await preflightRefusal(["https://a.example", "https://b.example"], { size: 1 }, {
      fetch: byHost({ "a.example": respond(413), "b.example": respond(413, "Max 50 MB") }),
    });
    expect(all).toEqual({ status: 413, reason: "Max 50 MB" });
  });

  it("doesn't wait on an unresponsive server once another has answered", async () => {
    const result = await preflightRefusal(["https://hung.example", "https://b.example"], { size: 1 }, {
      fetch: (input) => new URL(String(input)).host === "hung.example" ? new Promise<Response>(() => {}) : Promise.resolve(respond(200)),
    });
    expect(result).toBeUndefined();
  });

  it("has nothing to say with no servers", async () => {
    expect(await preflightRefusal([], { size: 1 })).toBeUndefined();
  });
});

describe("uploadFailureReason", () => {
  it("digs the server's reason out of Promise.any's AggregateError", () => {
    const error = new AggregateError([
      new TypeError("Failed to fetch"),
      new Error("Blossom request failed (413): File exceeds 50 MB"),
    ]);
    expect(uploadFailureReason(error)).toBe("File exceeds 50 MB");
  });

  it("falls back to wording for the status when the body is an HTML page", () => {
    const error = new AggregateError([new Error("Blossom request failed (413): <html><body>Too large</body></html>")]);
    expect(uploadFailureReason(error)).toBe(describeRefusal({ status: 413 }));
  });

  it("has nothing to say about an error that isn't a server's answer", () => {
    expect(uploadFailureReason(new AggregateError([new TypeError("Failed to fetch")]))).toBeUndefined();
    expect(uploadFailureReason("weird")).toBeUndefined();
  });
});

describe("encryptedUploadFailureReason", () => {
  it("names the encrypted-file policy when a server refused", () => {
    const error = new AggregateError([
      new Error("Blossom request failed (401): "),
      new Error("Blossom request failed (415): File type not allowed"),
    ]);
    expect(encryptedUploadFailureReason(error)).toMatch(/don't accept encrypted files/);
  });

  it("has nothing to say when no server answered", () => {
    expect(encryptedUploadFailureReason(new AggregateError([new TypeError("Failed to fetch")]))).toBeUndefined();
  });
});

describe("uploadTimeoutMs", () => {
  it("keeps the old floor for a small file and grows with the bytes", () => {
    expect(uploadTimeoutMs(0)).toBe(30_000);
    expect(uploadTimeoutMs(100 * 1024 * 1024)).toBeGreaterThan(30 * 60 * 1000);
  });
});
