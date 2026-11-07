/**
 * The Vector parity ledger: every decision point Vector makes (a refusal, a fold's
 * `refuse`, a vend verdict, a permission gate, a branch on ranked vs legacy roles),
 * extracted by `scripts/vector-parity/extract.mjs`, and the Armada test that
 * reproduces it. A point the ledger doesn't name fails here, so a Vector release's
 * new points surface when `points.json` is regenerated against it.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import ledger from "../../../scripts/vector-parity/ledger.json";
import points from "../../../scripts/vector-parity/points.json";

type Entry = { status: "covered"; test: string; title: string } | { status: "n/a"; why: string } | { status: "todo" };
const entries = ledger as Record<string, Entry>;
const ids = new Set((points as Array<{ id: string }>).map((p) => p.id));

describe("Vector parity ledger", () => {
  it("names every Vector decision point, and only those", () => {
    expect([...ids].filter((id) => !(id in entries)), "points with no ledger entry").toEqual([]);
    expect(Object.keys(entries).filter((id) => !ids.has(id)), "entries for points Vector no longer has").toEqual([]);
  });

  it("points every covered entry at a test that exists", () => {
    const missing = Object.entries(entries).flatMap(([id, e]) => {
      if (e.status !== "covered") return [];
      if (!existsSync(e.test)) return [`${id}: no file ${e.test}`];
      return readFileSync(e.test, "utf8").includes(e.title) ? [] : [`${id}: no test titled "${e.title}" in ${e.test}`];
    });
    expect(missing).toEqual([]);
  });

  it("gives every n/a entry a reason", () => {
    expect(Object.entries(entries).filter(([, e]) => e.status === "n/a" && !e.why.trim()).map(([id]) => id)).toEqual([]);
  });

  for (const [id, e] of Object.entries(entries)) if (e.status === "todo") it.todo(id);
});
