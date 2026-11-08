import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";

globalThis.indexedDB = new IDBFactory();
const { settleBook } = await import("@/concord/lib/owedSettle");
const { __resetFoldedForTests } = await import("@/lib/foldedCache");
type FoldedControl = import("@/concord/lib/control").FoldedControl;

const fold = (tag: string) => ({ ownerHex: tag, roster: { roles: [], grants: [], everyone: 1n }, banned: new Set([tag]) }) as unknown as FoldedControl;
let cid = 0;

describe("a settle owed until a whole read lands (Vector `owe_settle`, `run_owed_settle`)", () => {
  let id: string;
  beforeEach(() => {
    id = (++cid).toString(16).padStart(64, "0");
  });

  it("keeps the Roster a change started from through a failed read and a restart", async () => {
    const book = settleBook(id);
    await book.owe(fold("before"));
    const first = await book.begin();
    expect(first.from?.ownerHex).toBe("before");
    await book.end(false);
    __resetFoldedForTests();
    const later = await settleBook(id).begin();
    expect(later.settle).toBe(true);
    expect(later.from?.ownerHex).toBe("before");
    expect(later.from?.banned.has("before")).toBe(true);
  });

  it("keeps a settle of everything through a failed read and a restart, and clears it once settled", async () => {
    const book = settleBook(id);
    await book.owe(undefined);
    await book.begin();
    await book.end(false);
    __resetFoldedForTests();
    const restarted = settleBook(id);
    const later = await restarted.begin();
    expect(later).toEqual({ settle: true });
    await restarted.end(true);
    __resetFoldedForTests();
    expect((await settleBook(id).begin()).settle).toBe(false);
  });

  it("keeps the earliest, so the owed settle covers every change since", async () => {
    const book = settleBook(id);
    await book.owe(fold("first"));
    await book.owe(fold("second"));
    expect((await book.begin()).from?.ownerHex).toBe("first");
  });

  it("clears once settled, but keeps a change made while it ran", async () => {
    const book = settleBook(id);
    await book.owe(fold("before"));
    await book.begin();
    await book.owe(fold("midrun"));
    expect(await book.end(true), "owes another pass").toBe(true);
    expect((await settleBook(id).begin()).from?.ownerHex).toBe("midrun");
    const quiet = settleBook(id);
    await quiet.begin();
    await quiet.end(true);
    expect((await settleBook(id).begin()).settle).toBe(false);
  });

  it("settles everything when asked with no fold to start from", async () => {
    const book = settleBook(id);
    await book.owe(undefined);
    const run = await book.begin();
    expect(run.settle).toBe(true);
    expect(run.from).toBeUndefined();
  });
});
