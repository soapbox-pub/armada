import { sha1 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { isLocalNetworkUrl, isMagnetUri, MAGNET_MAX_LENGTH, sanitizeUrl } from "@/lib/sanitizeUrl";

const MAX_DEPTH = 32;
const MAX_VALUES = 100_000;
const MAX_FILES = 500;
const MAX_PATH = 1024;
const MAX_TRACKERS = 16;
const MAX_TRACKER_BYTES = 4096;
const MAX_WEB_SEEDS = 8;
const SHA1_BYTES = 20;
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

type Value = number | Uint8Array | Value[] | Dict;
type Dict = Map<string, Value>;

export interface TorrentMetainfo {
  name: string;
  files: { path: string; size: number }[];
  fileCount: number;
  size: number;
  pieceSize: number;
  pieceCount: number;
  hash: string;
  /** Lowercase hex SHA-1 of the info dict, for v1 and hybrid torrents. */
  btih?: string;
  /** Lowercase hex SHA-256 of the info dict, for v2 and hybrid torrents. */
  btmh?: string;
  magnet: string;
  trackers: string[];
  created?: number;
  createdBy: string;
  comment: string;
  private: boolean;
}

function invalid(): never {
  throw new Error("Invalid torrent metainfo");
}

function decode(bytes: Uint8Array) {
  let pos = 0;
  let values = 0;
  let rawInfo: Uint8Array | undefined;

  function digits(): number {
    const start = pos;
    let n = 0;
    while (bytes[pos] >= 48 && bytes[pos] <= 57) {
      n = n * 10 + (bytes[pos++] - 48);
      if (!Number.isSafeInteger(n)) { invalid(); }
    }
    if (pos === start || (bytes[start] === 48 && pos - start > 1)) { invalid(); }
    return n;
  }

  function takeString(): Uint8Array {
    const length = digits();
    if (bytes[pos++] !== 58 || length > bytes.length - pos) { invalid(); }
    const start = pos;
    pos += length;
    return bytes.subarray(start, pos);
  }

  function value(depth: number): Value {
    if (++values > MAX_VALUES || depth > MAX_DEPTH) { invalid(); }
    switch (bytes[pos]) {
      case 100: { // d
        pos++;
        const entries: Dict = new Map();
        while (bytes[pos] !== 101) {
          const key = decoder.decode(takeString());
          if (entries.has(key)) { invalid(); }
          const start = pos;
          entries.set(key, value(depth + 1));
          if (depth === 0 && key === "info") { rawInfo = bytes.subarray(start, pos); }
        }
        pos++;
        return entries;
      }
      case 108: { // l
        pos++;
        const items: Value[] = [];
        while (bytes[pos] !== 101) { items.push(value(depth + 1)); }
        pos++;
        return items;
      }
      case 105: { // i
        pos++;
        const negative = bytes[pos] === 45;
        if (negative) { pos++; }
        const n = digits();
        if (bytes[pos++] !== 101 || (negative && n === 0)) { invalid(); }
        return negative ? -n : n;
      }
      default:
        return takeString();
    }
  }

  const root = value(0);
  if (!(root instanceof Map) || !rawInfo || pos !== bytes.length) { invalid(); }
  return { root, rawInfo };
}

// Control and bidi-override characters can disguise a name (`gpj.exe` shown as `exe.jpg`).
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

/** Sender-chosen text made safe to display. */
export function cleanTorrentText(text: string): string {
  return text.replace(UNSAFE_TEXT, "").trim();
}

function string(value: Value | undefined, max: number): string {
  if (!(value instanceof Uint8Array)) { return ""; }
  // A cut through a multi-byte character decodes to U+FFFD.
  const text = decoder.decode(value.subarray(0, max));
  return cleanTorrentText(value.length > max ? text.replace(/\uFFFD+$/, "") : text);
}

function lengthOf(value: Value | undefined): number {
  if (typeof value !== "number" || value < 0) { invalid(); }
  return value;
}

function readTrackers(root: Dict) {
  const trackers = new Map<string, string>();
  let remaining = MAX_TRACKER_BYTES;
  function add(value: Value | undefined) {
    if (!(value instanceof Uint8Array) || value.length > remaining || trackers.size === MAX_TRACKERS) { return; }
    const tracker = decoder.decode(value);
    if (trackers.has(tracker) || /[\s\p{Cc}]/u.test(tracker)) { return; }
    if (!/^(https?|udp|wss):\/\//i.test(tracker)) { return; }
    try {
      const { host } = new URL(tracker);
      if (host) {
        trackers.set(tracker, host);
        remaining -= value.length;
      }
    } catch { /* Ignore malformed tracker URLs. */ }
  }

  add(root.get("announce"));
  const tiers = root.get("announce-list");
  if (Array.isArray(tiers)) {
    for (const tier of tiers) {
      if (Array.isArray(tier)) {
        for (const tracker of tier) { add(tracker); }
      }
    }
  }
  return trackers;
}

export function parseTorrent(bytes: Uint8Array): TorrentMetainfo {
  // Strings are told apart by `instanceof`, so they must share this realm's Uint8Array.
  const { root, rawInfo } = decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const info = root.get("info");
  if (!(info instanceof Map)) { invalid(); }
  const name = string(info.get("name.utf-8") ?? info.get("name"), MAX_PATH);
  const pieceSize = lengthOf(info.get("piece length"));
  const pieces = info.get("pieces");
  const v1 = pieces instanceof Uint8Array && pieces.length % SHA1_BYTES === 0;
  const version = info.get("meta version");
  const v2 = version === 2;
  if (!name || !pieceSize || (!v1 && !v2) || (version !== undefined && !v2)) { invalid(); }

  const files: { path: string; size: number }[] = [];
  let fileCount = 0;
  let size = 0;
  let pieceCount = 0;
  function addFile(path: string, file: Dict) {
    const length = lengthOf(file.get("length"));
    if (string(file.get("attr"), 16).includes("p")) { return; }
    if (!path) { invalid(); }
    size += length;
    if (!Number.isSafeInteger(size)) { invalid(); }
    fileCount++;
    pieceCount += Math.ceil(length / pieceSize);
    if (files.length < MAX_FILES) { files.push({ path: path.slice(0, MAX_PATH), size: length }); }
  }

  function walkTree(tree: Dict, path: string) {
    for (const [part, child] of tree) {
      if (!(child instanceof Map)) { invalid(); }
      if (!part) {
        addFile(path, child);
      } else {
        walkTree(child, path ? `${path}/${part.slice(0, MAX_PATH)}`.slice(0, MAX_PATH) : part.slice(0, MAX_PATH));
      }
    }
  }

  if (v1) {
    const list = info.get("files");
    if (list === undefined) {
      addFile(name, info);
    } else {
      if (!Array.isArray(list)) { invalid(); }
      for (const file of list) {
        if (!(file instanceof Map)) { invalid(); }
        const path = file.get("path.utf-8") ?? file.get("path");
        if (!Array.isArray(path) || path.length === 0) { invalid(); }
        addFile(path.map((part) => {
          const component = string(part, MAX_PATH);
          if (!component) { invalid(); }
          return component;
        }).join("/"), file);
      }
    }
    pieceCount = pieces.length / SHA1_BYTES;
  } else {
    const tree = info.get("file tree");
    if (!(tree instanceof Map)) { invalid(); }
    walkTree(tree, "");
  }
  if (!fileCount) { invalid(); }

  // A decoded and re-encoded dictionary may hash differently from the bytes clients receive.
  const btih = v1 ? bytesToHex(sha1(rawInfo)) : undefined;
  const btmh = v2 ? bytesToHex(sha256(rawInfo)) : undefined;
  const trackers = readTrackers(root);
  const webSeeds: string[] = [];
  const urlList = root.get("url-list");
  for (const seed of Array.isArray(urlList) ? urlList : [urlList]) {
    const url = sanitizeUrl(string(seed, 2048));
    if (url && webSeeds.length < MAX_WEB_SEEDS && !webSeeds.includes(url)) { webSeeds.push(url); }
  }

  const created = root.get("creation date");
  return {
    name, files, fileCount, size, pieceSize, pieceCount,
    hash: btih ?? btmh ?? invalid(),
    btih, btmh,
    magnet: buildMagnet({ btih, btmh, name, size, trackers: [...trackers.keys()], webSeeds }),
    trackers: [...trackers.values()],
    created: typeof created === "number" && created > 0 && created <= 8.64e12 ? created : undefined,
    createdBy: string(root.get("created by"), 512),
    comment: string(root.get("comment.utf-8") ?? root.get("comment"), 512),
    private: info.get("private") === 1,
  };
}

/**
 * A magnet for the torrent: hashes, name and size, then trackers and web seeds
 * while it stays a length {@link isMagnetUri} accepts.
 */
function buildMagnet(t: { btih?: string; btmh?: string; name: string; size: number; trackers: string[]; webSeeds: string[] }): string {
  const params: string[] = [];
  if (t.btih) { params.push(`xt=urn:btih:${t.btih}`); }
  if (t.btmh) { params.push(`xt=urn:btmh:1220${t.btmh}`); }
  params.push(`dn=${encodeURIComponent(t.name)}`, `xl=${t.size}`);
  let magnet = `magnet:?${params.join("&")}`;
  const extras = [
    ...t.trackers.map((tr) => `tr=${encodeURIComponent(tr)}`),
    ...t.webSeeds.map((ws) => `ws=${encodeURIComponent(ws)}`),
  ];
  for (const extra of extras) {
    if (magnet.length + extra.length + 1 > MAGNET_MAX_LENGTH) { break; }
    magnet += `&${extra}`;
  }
  return magnet;
}

export interface MagnetLink {
  /** The magnet's `dn`, cleaned; empty when it names nothing. */
  name: string;
  /** The magnet's `xl`, when it declares one. */
  size?: number;
  hash: string;
  btih?: string;
  btmh?: string;
  /** Tracker hosts, for display. */
  trackers: string[];
  magnet: string;
  /**
   * The magnet's public http(s) `xs` .torrent URL: the only place a .torrent
   * for a magnet is fetched from, and only kept if it hashes to the magnet.
   */
  exactSource?: string;
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32 to hex; BEP 9 allows a 32-character btih. */
function base32ToHex(text: string): string {
  let bits = 0;
  let value = 0;
  let hex = "";
  for (const char of text.toLowerCase()) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      hex += ((value >>> (bits - 8)) & 0xff).toString(16).padStart(2, "0");
      bits -= 8;
    }
  }
  return hex;
}

/** A magnet URI read for display, or undefined unless {@link isMagnetUri} accepts it with a full hash. */
export function parseMagnet(uri: string): MagnetLink | undefined {
  if (!isMagnetUri(uri)) { return undefined; }
  const params = new URLSearchParams(uri.slice(uri.indexOf("?") + 1));
  let btih: string | undefined;
  let btmh: string | undefined;
  for (const xt of params.getAll("xt")) {
    const v1 = /^urn:btih:([0-9a-f]{40}|[a-z2-7]{32})$/i.exec(xt);
    if (v1 && !btih) { btih = v1[1].length === 40 ? v1[1].toLowerCase() : base32ToHex(v1[1]); }
    const v2 = /^urn:btmh:1220([0-9a-f]{64})$/i.exec(xt);
    if (v2 && !btmh) { btmh = v2[1].toLowerCase(); }
  }
  const hash = btih ?? btmh;
  if (!hash) { return undefined; }

  const trackers: string[] = [];
  for (const tracker of params.getAll("tr")) {
    if (trackers.length === MAX_TRACKERS || !/^(https?|udp|wss):\/\//i.test(tracker)) { continue; }
    try {
      const { host } = new URL(tracker);
      if (host && !trackers.includes(host)) { trackers.push(host); }
    } catch { /* Ignore malformed tracker URLs. */ }
  }
  const xl = params.get("xl");
  const exactSource = params.getAll("xs")
    .map((xs) => (xs.length <= 2048 ? sanitizeUrl(xs) : undefined))
    .find((xs): xs is string => !!xs && !isLocalNetworkUrl(xs));
  return {
    name: cleanTorrentText(params.get("dn") ?? "").slice(0, MAX_PATH),
    size: xl && /^[0-9]{1,15}$/.test(xl) ? Number(xl) : undefined,
    hash, btih, btmh, trackers, magnet: uri, exactSource,
  };
}

/** Whether a fetched torrent is the content a magnet names: every hash the magnet carries must match. */
export function torrentMatchesMagnet(torrent: TorrentMetainfo, magnet: MagnetLink): boolean {
  if (magnet.btih && magnet.btih !== torrent.btih) { return false; }
  if (magnet.btmh && magnet.btmh !== torrent.btmh) { return false; }
  return Boolean(magnet.btih || magnet.btmh);
}
