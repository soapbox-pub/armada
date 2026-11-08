import { describe, expect, it } from "vitest";

import type { CatchUpVerdict } from "@/concord/lib/catchUpAdoption";
import { catchUpIsManual, catchUpIsRefused, setCatchUpVerdict, verdictIsManual } from "@/concord/lib/catchUpVerdicts";

describe("which catch-up verdicts wait on a click", () => {
  it("offers the refusals a member may overrule, and none that are waiting or done", () => {
    const manual: CatchUpVerdict[] = ["sender-unauthorized", "not-entitled"];
    const silent: Array<CatchUpVerdict | undefined> = [undefined, "adopt", "no-fold", "nothing-new"];
    for (const v of manual) expect(verdictIsManual(v)).toBe(true);
    for (const v of silent) expect(verdictIsManual(v)).toBe(false);
  });

  it("never offers a banned vendor's, an implausible epoch's, or a banned recipient's, and Accept refuses them", () => {
    for (const v of ["sender-banned", "implausible-epoch", "banned"] as const) {
      const wrap = `wrap-${v}`;
      setCatchUpVerdict(wrap, v);
      expect(catchUpIsManual(wrap)).toBe(false);
      expect(catchUpIsRefused(wrap)).toBe(true);
    }
    setCatchUpVerdict("wrap-manual", "sender-unauthorized");
    expect(catchUpIsRefused("wrap-manual")).toBe(false);
  });
});
