import { describe, expect, it } from "vitest";

import { isNsiteUrl } from "./nsiteUrl";

const NPUB = "npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg";
const B36 = "35hya087sv94zz8ba0au26r7o7wodxktvjqkata0j1rfuoxj66";
const NADDR_SITE =
  "naddr1qvzqqqyf8qpzqln7n3p2jxl77x06j209lksmwtswhsdycy2pvulz09prfkr2mh6wqy2hwumn8ghj7un9d3shjtnyd968gmewwp6kyqqxv9ex6ctyvyjcxs9a";
const NADDR_ARTICLE = "naddr1qvzqqqr4gupzqln7n3p2jxl77x06j209lksmwtswhsdycy2pvulz09prfkr2mh6wqqz8qmmnwswvlk03";
const NSEC = "nsec10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qw6eqda";

describe("isNsiteUrl", () => {
  it("accepts every spelling that names a site", () => {
    expect(isNsiteUrl(`nsite://${NPUB}/`)).toBe(true);
    expect(isNsiteUrl(`nsite://${NPUB}`)).toBe(true);
    expect(isNsiteUrl(`nsite://${NPUB.toUpperCase()}/a/b?c=d#e`)).toBe(true);
    expect(isNsiteUrl(`nsite://${B36}armada/chat`)).toBe(true);
    expect(isNsiteUrl(`nsite://v${B36}/`)).toBe(true);
    expect(isNsiteUrl(`nsite://${NADDR_SITE}/`)).toBe(true);
  });

  it("refuses a host that names no key", () => {
    expect(isNsiteUrl("nsite://example.com/")).toBe(false);
    expect(isNsiteUrl("nsite://alice@example.com/")).toBe(false);
    expect(isNsiteUrl(`nsite://${B36}/`)).toBe(false);
    expect(isNsiteUrl(`nsite://${B36}armada-/`)).toBe(false);
    expect(isNsiteUrl(`nsite://${B36}abc%2Fevil/`)).toBe(false);
    expect(isNsiteUrl(`nsite://${NADDR_ARTICLE}/`)).toBe(false);
    expect(isNsiteUrl(`nsite://${NSEC}/`)).toBe(false);
    expect(isNsiteUrl(`nsite://${NPUB}:8080/`)).toBe(false);
    expect(isNsiteUrl(`https://${NPUB}/`)).toBe(false);
    expect(isNsiteUrl("nsite://")).toBe(false);
  });
});
