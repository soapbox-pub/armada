import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { configureLowMemory, readLowMemoryMode, writeLowMemoryMode } = require("./lowMemory.js");

describe("low memory mode", () => {
  const dirs = [];
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), "armada-lowmem-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("is off until set, persists, and turns off by removing its file", () => {
    const userDataPath = dir();
    expect(readLowMemoryMode({ userDataPath })).toBe(false);
    writeLowMemoryMode(true, { userDataPath });
    expect(readFileSync(join(userDataPath, "low-memory-mode"), "utf8")).toBe("on\n");
    expect(readLowMemoryMode({ userDataPath })).toBe(true);
    writeLowMemoryMode(false, { userDataPath });
    expect(readLowMemoryMode({ userDataPath })).toBe(false);
  });

  it("tunes V8 for size only when on", () => {
    const commandLine = { appendSwitch: vi.fn() };
    const v8 = { setFlagsFromString: vi.fn() };
    configureLowMemory({ commandLine, on: false, v8 });
    expect(commandLine.appendSwitch).not.toHaveBeenCalled();
    expect(v8.setFlagsFromString).not.toHaveBeenCalled();
    configureLowMemory({ commandLine, on: true, v8 });
    expect(commandLine.appendSwitch).toHaveBeenCalledWith("js-flags", "--optimize-for-size");
    expect(v8.setFlagsFromString).toHaveBeenCalledWith("--optimize-for-size");
  });
});
