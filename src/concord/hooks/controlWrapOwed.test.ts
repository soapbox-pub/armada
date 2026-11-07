import { describe, expect, it } from "vitest";

import { controlWrapOwed } from "@/concord/hooks/useRoles";
import { controlSignerGroupKey, random32 } from "@/concord/lib/derive";
import type { Community } from "@/concord/lib/types";

const nip44 = { encrypt: async (_pk: string, plain: string) => `sealed:${plain}` };
const MEMBER = "ab".repeat(32);

function community(o: { controlRoot?: Uint8Array; controlPk?: string } = {}): Community {
  const id = random32();
  const root = random32();
  return {
    id,
    rootEpoch: 2n,
    controlRoot: root,
    controlPk: controlSignerGroupKey(root, id, 2n).pk,
    ...o,
  } as unknown as Community;
}

describe("the staff write key a promotion delivers (CORD-04 §3, Vector `control_wrap_owed`)", () => {
  it("delivers the held key when it derives to the Control address", async () => {
    expect(await controlWrapOwed(community(), true, nip44, MEMBER)).toMatch(/^sealed:/);
  });

  it("owes nothing to a non-staff Grant or on a legacy epoch", async () => {
    expect(await controlWrapOwed(community(), false, nip44, MEMBER)).toBeUndefined();
    expect(await controlWrapOwed(community({ controlPk: undefined }), true, nip44, MEMBER)).toBeUndefined();
  });

  it("refuses to promote without the key", async () => {
    await expect(controlWrapOwed(community({ controlRoot: undefined }), true, nip44, MEMBER)).rejects.toThrow(/staff write key/);
  });

  it("refuses to deliver a held key that doesn't derive to the Control address", async () => {
    await expect(controlWrapOwed(community({ controlRoot: random32() }), true, nip44, MEMBER)).rejects.toThrow(/damaged/);
  });
});
