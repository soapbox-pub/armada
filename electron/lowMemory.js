const fs = require("node:fs");
const path = require("node:path");

// Low memory mode: V8 tuned for size in every process. Measured on the desktop
// app in a busy community (scripts/electron-profile.mjs): about 30 MB less
// logged out and 45 MB less with the community open, for JavaScript that runs
// about 40% slower. A trade for machines short on RAM, never the default.
// Process-wide, so it is read before app readiness and applies from the next launch.

const FILE = "low-memory-mode";

function lowMemoryModePath(userDataPath) {
  return path.join(userDataPath, FILE);
}

function readLowMemoryMode({ userDataPath, fsImpl = fs } = {}) {
  if (!userDataPath) return false;
  try {
    return fsImpl.readFileSync(lowMemoryModePath(userDataPath), "utf8").trim() === "on";
  } catch {
    return false;
  }
}

function writeLowMemoryMode(on, { userDataPath, fsImpl = fs } = {}) {
  if (!userDataPath) return false;
  fsImpl.mkdirSync(userDataPath, { recursive: true });
  if (on) fsImpl.writeFileSync(lowMemoryModePath(userDataPath), "on\n", { mode: 0o600 });
  else fsImpl.rmSync(lowMemoryModePath(userDataPath), { force: true });
  return true;
}

function configureLowMemory({ commandLine, on, v8 = require("node:v8") }) {
  if (!on) return;
  // The switch reaches the renderers; this process's V8 is already running.
  commandLine.appendSwitch("js-flags", "--optimize-for-size");
  v8.setFlagsFromString("--optimize-for-size");
}

module.exports = { configureLowMemory, lowMemoryModePath, readLowMemoryMode, writeLowMemoryMode };
