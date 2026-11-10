const fs = require("node:fs");
const path = require("node:path");

// Which web deploys the shell follows (webSite.js): "latest" (every push to
// main, the default), "release" (stable releases only) or "off" (keep the web
// app it has). Per install, in userData, so it applies before any page loads.

const FILE = "web-update-channel";
const CHANNELS = ["latest", "release", "off"];

function readWebUpdateChannel({ userDataPath, fsImpl = fs } = {}) {
  if (!userDataPath) return "latest";
  try {
    const value = fsImpl.readFileSync(path.join(userDataPath, FILE), "utf8").trim();
    return CHANNELS.includes(value) ? value : "latest";
  } catch {
    return "latest";
  }
}

function writeWebUpdateChannel(channel, { userDataPath, fsImpl = fs } = {}) {
  if (!userDataPath || !CHANNELS.includes(channel)) return false;
  fsImpl.mkdirSync(userDataPath, { recursive: true });
  if (channel === "latest") fsImpl.rmSync(path.join(userDataPath, FILE), { force: true });
  else fsImpl.writeFileSync(path.join(userDataPath, FILE), `${channel}\n`, { mode: 0o600 });
  return true;
}

module.exports = { readWebUpdateChannel, writeWebUpdateChannel };
