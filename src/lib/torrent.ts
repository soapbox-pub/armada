import { sha1 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const MAX_DEPTH = 32;
const MAX_VALUES = 100_000;
const MAX_FILES = 500;
const MAX_PATH = 1024;
const MAX_TRACKERS = 16;
const MAX_TRACKER_BYTES = 4096;
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

function string(value: Value | undefined, max: number): string {
  return value instanceof Uint8Array ? decoder.decode(value.subarray(0, max)) : "";
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
    if (!/^(https?|udp):\/\//i.test(tracker)) { return; }
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
  const { root, rawInfo } = decode(bytes);
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
  const params: string[] = [];
  if (btih) { params.push(`xt=urn:btih:${btih}`); }
  if (btmh) { params.push(`xt=urn:btmh:1220${btmh}`); }
  params.push(`dn=${encodeURIComponent(name)}`);
  const trackers = readTrackers(root);
  for (const tracker of trackers.keys()) { params.push(`tr=${encodeURIComponent(tracker)}`); }

  const created = root.get("creation date");
  return {
    name, files, fileCount, size, pieceSize, pieceCount,
    hash: btih ?? btmh ?? invalid(),
    magnet: `magnet:?${params.join("&")}`,
    trackers: [...trackers.values()],
    created: typeof created === "number" && created > 0 && created <= 8.64e12 ? created : undefined,
    createdBy: string(root.get("created by"), 512),
    comment: string(root.get("comment.utf-8") ?? root.get("comment"), 512),
    private: info.get("private") === 1,
  };
}
