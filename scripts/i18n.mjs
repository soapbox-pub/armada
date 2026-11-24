#!/usr/bin/env node
/*
 * Translation catalogs.
 *
 *   node scripts/i18n.mjs extract   write src/i18n/locales/en.json from the source,
 *                                   dropping from every catalog the translation of
 *                                   any message whose English changed, so `check`
 *                                   reports it missing until it is retranslated
 *   node scripts/i18n.mjs check     fail unless en.json matches the source; every
 *                                   catalog has exactly its ids, with the same
 *                                   placeholders and tags in each message; and the
 *                                   Android/iOS notification tables match them
 *   node scripts/i18n.mjs missing [locale]
 *                                   print the English of every id a catalog lacks
 *   node scripts/i18n.mjs format    sort and reformat every catalog
 *
 * English is never loaded at runtime — it is each call site's defaultMessage —
 * so en.json exists for this check and for translators.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse, TYPE } from "@formatjs/icu-messageformat-parser";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const localesDir = join(root, "src/i18n/locales");
const TRANSLATED = ["de", "es", "fr", "it", "nl", "pt", "ja"];

function extract() {
  const dir = mkdtempSync(join(tmpdir(), "armada-i18n-"));
  const out = join(dir, "en.json");
  try {
    execFileSync(
      process.execPath,
      [
        join(root, "node_modules/@formatjs/cli/bin/formatjs"),
        "extract",
        "src/**/*.{ts,tsx}",
        "--ignore", "src/**/*.test.{ts,tsx}",
        "--ignore", "src/**/*.d.ts",
        "--additional-function-names", "t",
        "--format", "simple",
        "--throws",
        "--out-file", out,
      ],
      { cwd: root, stdio: ["ignore", "ignore", "inherit"] },
    );
    return sortKeys(JSON.parse(readFileSync(out, "utf8")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function sortKeys(obj) {
  return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]));
}

function serialize(obj) {
  return JSON.stringify(sortKeys(obj), null, 2) + "\n";
}

function readCatalog(locale) {
  return JSON.parse(readFileSync(join(localesDir, `${locale}.json`), "utf8"));
}

/** Argument names (with their kind) and tag names a message uses, as a comparable signature. */
function signature(message) {
  const found = new Set();
  const walk = (nodes) => {
    for (const node of nodes) {
      switch (node.type) {
        case TYPE.argument: found.add(`{${node.value}}`); break;
        case TYPE.number: found.add(`{${node.value}, number}`); break;
        case TYPE.date: found.add(`{${node.value}, date}`); break;
        case TYPE.time: found.add(`{${node.value}, time}`); break;
        case TYPE.select:
          found.add(`{${node.value}, select}`);
          for (const option of Object.values(node.options)) walk(option.value);
          break;
        case TYPE.plural:
          found.add(`{${node.value}, plural}`);
          for (const option of Object.values(node.options)) walk(option.value);
          break;
        case TYPE.tag:
          found.add(`<${node.value}>`);
          walk(node.children);
          break;
      }
    }
  };
  walk(parse(message));
  return [...found].sort().join(" ");
}

/**
 * Problems the extractor is silent about, found by reading the source:
 * descriptors it did not see (one called through an alias such as
 * `const m = intl.formatMessage`, or a bare object outside `defineMessage`),
 * which type-check and render but only ever in English; and a defaultMessage
 * with leading or trailing whitespace, which the extractor trims, so every
 * translation silently loses the space the English keeps.
 */
function sourceProblems(source) {
  const found = [];
  const id = String.raw`["']([a-z][\w-]*(?:\.[\w-]+)+)["']`;
  const descriptors = [
    new RegExp(String.raw`\bid\s*:\s*${id}\s*,(?:\s*description\s*:\s*(?:"[^"]*"|'[^']*')\s*,)?\s*defaultMessage\s*:`, "g"),
    new RegExp(String.raw`\bdefaultMessage\s*:\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*,(?:\s*description\s*:\s*(?:"[^"]*"|'[^']*')\s*,)?\s*id\s*:\s*${id}`, "g"),
  ];
  const padded = /\bdefaultMessage\s*[:=]\s*(?:\{\s*)?(["'`])(\s[^"'`]*|[^"'`]*\s)\1/g;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.|\.d\.ts$/.test(entry.name)) {
        const text = readFileSync(path, "utf8");
        const rel = path.slice(root.length + 1);
        for (const pattern of descriptors) {
          for (const [, msgId] of text.matchAll(pattern)) {
            if (!(msgId in source)) found.push(`${rel}: ${msgId} is not extracted — call intl.formatMessage/t() directly or wrap it in defineMessage`);
          }
        }
        for (const [match] of text.matchAll(padded)) {
          found.push(`${rel}: ${match.trim()} — the extractor trims a defaultMessage, so put the space outside the message`);
        }
      }
    }
  };
  walk(join(root, "src"));
  return found;
}

/*
 * The iOS notification extension carries its own copy of the `notification.*`
 * messages (ios/ArmadaNotify/Sources/ArmadaNotify/Strings.swift). Each Swift key
 * is one catalog message, or one branch of a select/plural in it.
 */
const SWIFT_STRINGS = join(root, "ios/ArmadaNotify/Sources/ArmadaNotify/Strings.swift");
const SWIFT_KEYS = {
  reacted: ["notification.reacted"],
  repliedInThreadWith: ["notification.repliedInThreadWith"],
  repliedInThread: ["notification.repliedInThread"],
  sentGif: ["notification.sentMedia", "gif"],
  sentImage: ["notification.sentMedia", "image"],
  sentVideo: ["notification.sentMedia", "video"],
  sentVoice: ["notification.sentMedia", "voice"],
  sentGame: ["notification.sentMedia", "game"],
  sentFile: ["notification.sentFile"],
  sentDirectMessage: ["notification.sentDirectMessage"],
  sentMessage: ["notification.sentMessage"],
  mentionedYou: ["notification.mentionedYou"],
  attributed: ["notification.attributed"],
  chat: ["notification.chat"],
  anonymous: ["notification.anonymous"],
  appName: ["notification.appName"],
  messagesSynced: ["notification.messagesSynced"],
  newMessage: ["notification.newMessage"],
  newDirectMessage: ["notification.newDirectMessage"],
  newCommunityMessage: ["notification.newCommunityMessage"],
  newChannelMessage: ["notification.newChannelMessage"],
  someoneMentionedYou: ["notification.someoneMentionedYou"],
  messageRequests: ["notification.messageRequests"],
  newMessageRequestOne: ["notification.newMessageRequest", "one"],
  newMessageRequestOther: ["notification.newMessageRequest", "other"],
  roomTitle: ["notification.roomTitle"],
  channelTitle: ["notification.channelTitle"],
};

/**
 * A message as plain `{name}` text, with its select/plural (if any) replaced
 * in place by the `branch` option: what a native table spells as one string.
 */
function flatTemplate(message, branch) {
  const render = (nodes) => nodes.map((n) => {
    if (n.type === TYPE.literal) return n.value;
    if (n.type === TYPE.argument) return `{${n.value}}`;
    if ((n.type === TYPE.select || n.type === TYPE.plural) && branch) {
      const option = n.options[branch] ?? n.options.other;
      if (!option) throw new Error(`no "${branch}" branch`);
      return render(option.value);
    }
    throw new Error("more than plain text and {arguments}");
  }).join("");
  return render(parse(message));
}

function readSwiftTables() {
  const tables = {};
  let current;
  for (const line of readFileSync(SWIFT_STRINGS, "utf8").split("\n")) {
    const open = line.match(/^\s*"([a-z]+)": \[$/);
    if (open) {
      current = tables[open[1]] = {};
      continue;
    }
    const entry = current && line.match(/^\s*\.(\w+): "((?:[^"\\]|\\.)*)",$/);
    if (entry) {
      current[entry[1]] = entry[2]
        .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/\\(["\\])/g, "$1");
    }
  }
  return tables;
}

function swiftProblems(source) {
  const problems = [];
  const tables = readSwiftTables();
  for (const locale of ["en", ...TRANSLATED]) {
    const table = tables[locale];
    if (!table) {
      problems.push(`Strings.swift: no "${locale}" table`);
      continue;
    }
    const catalog = locale === "en" ? source : readCatalog(locale);
    for (const [key, [id, branch]] of Object.entries(SWIFT_KEYS)) {
      let expected;
      try {
        expected = flatTemplate(catalog[id] ?? source[id], branch);
      } catch (err) {
        problems.push(`Strings.swift: ${locale}.${key} (${id}): ${err.message}`);
        continue;
      }
      if (table[key] !== expected) {
        problems.push(`Strings.swift: ${locale}.${key} is ${JSON.stringify(table[key])}, ${locale}.json's ${id} is ${JSON.stringify(expected)}`);
      }
    }
    for (const key of Object.keys(table)) {
      if (!(key in SWIFT_KEYS)) problems.push(`Strings.swift: ${locale}.${key} maps to no catalog message (add it to SWIFT_KEYS)`);
    }
  }
  return problems;
}

/*
 * Android's notification service carries the same messages as string
 * resources (values[-<lang>]/strings.xml), with positional `%n$s` arguments.
 * Each entry: [catalog id, select/plural branch, argument names in % order].
 */
const ANDROID_RES = join(root, "android/app/src/main/res");
const ANDROID_KEYS = {
  notif_reacted: ["notification.reacted", null, ["emoji"]],
  notif_replied_in_thread_with: ["notification.repliedInThreadWith", null, ["text"]],
  notif_replied_in_thread: ["notification.repliedInThread"],
  notif_sent_gif: ["notification.sentMedia", "gif"],
  notif_sent_image: ["notification.sentMedia", "image"],
  notif_sent_video: ["notification.sentMedia", "video"],
  notif_sent_voice: ["notification.sentMedia", "voice"],
  notif_sent_game: ["notification.sentMedia", "game"],
  notif_sent_file: ["notification.sentFile"],
  notif_sent_direct_message: ["notification.sentDirectMessage"],
  notif_sent_message: ["notification.sentMessage"],
  notif_mentioned_you: ["notification.mentionedYou", null, ["text"]],
  notif_attributed: ["notification.attributed", null, ["name", "text"]],
  notif_chat: ["notification.chat"],
  notif_anonymous: ["notification.anonymous"],
  notif_room_title: ["notification.roomTitle", null, ["community", "channel"]],
  notif_new_message: ["notification.newMessage"],
  notif_new_direct_message: ["notification.newDirectMessage"],
  notif_git_issue: ["notification.gitActivity", "issue", ["name", "repository"]],
  notif_git_pr: ["notification.gitActivity", "pr", ["name", "repository"]],
  notif_git_comment: ["notification.gitActivity", "comment", ["name", "repository"]],
  notif_git_status: ["notification.gitActivity", "status", ["name", "repository"]],
};

function readAndroidStrings(locale) {
  const file = join(ANDROID_RES, locale === "en" ? "values" : `values-${locale}`, "strings.xml");
  const out = {};
  for (const [, name, raw] of readFileSync(file, "utf8").matchAll(/<string name="(\w+)"[^>]*>([\s\S]*?)<\/string>/g)) {
    let text = raw.trim();
    if (text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);
    out[name] = text
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")
      .replace(/\\([@'"?\\])/g, "$1")
      .replace(/\\n/g, "\n");
  }
  return out;
}

function androidProblems(source) {
  const problems = [];
  for (const locale of ["en", ...TRANSLATED]) {
    let strings;
    try {
      strings = readAndroidStrings(locale);
    } catch (err) {
      problems.push(`strings.xml (${locale}): ${err.message}`);
      continue;
    }
    const catalog = locale === "en" ? source : readCatalog(locale);
    for (const [key, [id, branch, args = []]] of Object.entries(ANDROID_KEYS)) {
      if (!(key in strings)) {
        problems.push(`strings.xml (${locale}): no ${key}`);
        continue;
      }
      const actual = strings[key].replace(/%(\d+)\$[sd]/g, (_, n) => `{${args[Number(n) - 1] ?? `%${n}`}}`);
      let expected;
      try {
        expected = flatTemplate(catalog[id] ?? source[id], branch);
      } catch (err) {
        problems.push(`strings.xml (${locale}): ${key} (${id}): ${err.message}`);
        continue;
      }
      if (actual !== expected) {
        problems.push(`strings.xml (${locale}): ${key} is ${JSON.stringify(actual)}, ${locale}.json's ${id} is ${JSON.stringify(expected)}`);
      }
    }
  }
  return problems;
}

function check() {
  const problems = [];
  const source = extract();
  const hidden = sourceProblems(source);
  if (hidden.length) problems.push(...hidden.slice(0, 20), ...(hidden.length > 20 ? [`…and ${hidden.length - 20} more`] : []));
  let committed = {};
  try {
    committed = readCatalog("en");
  } catch { /* reported below */ }
  if (serialize(source) !== serialize(committed)) {
    problems.push("src/i18n/locales/en.json is out of date with the source: run `npm run i18n:extract`.");
  }
  const english = Object.fromEntries(Object.entries(source).map(([id, msg]) => {
    try {
      return [id, signature(msg)];
    } catch (err) {
      problems.push(`en: ${id}: ${err.message}`);
      return [id, null];
    }
  }));
  for (const locale of TRANSLATED) {
    const catalog = readCatalog(locale);
    const missing = Object.keys(source).filter((id) => !(id in catalog));
    const extra = Object.keys(catalog).filter((id) => !(id in source));
    if (missing.length) problems.push(`${locale}: ${missing.length} missing: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ", …" : ""}`);
    if (extra.length) problems.push(`${locale}: ${extra.length} not in the source: ${extra.slice(0, 10).join(", ")}${extra.length > 10 ? ", …" : ""}`);
    for (const [id, msg] of Object.entries(catalog)) {
      if (!(id in source) || english[id] === null) continue;
      let sig;
      try {
        sig = signature(msg);
      } catch (err) {
        problems.push(`${locale}: ${id}: ${err.message}`);
        continue;
      }
      if (sig !== english[id]) problems.push(`${locale}: ${id}: uses ${sig || "nothing"}, English uses ${english[id] || "nothing"}`);
    }
    if (serialize(catalog) !== readFileSync(join(localesDir, `${locale}.json`), "utf8")) {
      problems.push(`${locale}.json is not sorted/formatted: run \`node scripts/i18n.mjs format\`.`);
    }
  }
  problems.push(...swiftProblems(source), ...androidProblems(source));
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`i18n: ${Object.keys(source).length} messages, ${TRANSLATED.length} catalogs complete.`);
}

const [command, arg] = process.argv.slice(2);
switch (command) {
  case "extract": {
    const source = extract();
    let previous = {};
    try {
      previous = readCatalog("en");
    } catch { /* first extraction */ }
    const changed = Object.keys(source).filter((id) => id in previous && previous[id] !== source[id]);
    if (changed.length) {
      for (const locale of TRANSLATED) {
        const catalog = readCatalog(locale);
        for (const id of changed) delete catalog[id];
        writeFileSync(join(localesDir, `${locale}.json`), serialize(catalog));
      }
      console.log(`English changed, translations dropped for retranslation:\n  ${changed.join("\n  ")}`);
    }
    writeFileSync(join(localesDir, "en.json"), serialize(source));
    break;
  }
  case "format":
    for (const locale of ["en", ...TRANSLATED]) {
      writeFileSync(join(localesDir, `${locale}.json`), serialize(readCatalog(locale)));
    }
    break;
  case "check":
    check();
    break;
  case "missing": {
    const source = extract();
    const out = {};
    if (arg && !TRANSLATED.includes(arg)) {
      console.error(`unknown locale "${arg}"; translated locales are ${TRANSLATED.join(", ")}`);
      process.exit(2);
    }
    for (const locale of arg ? [arg] : TRANSLATED) {
      const catalog = readCatalog(locale);
      for (const [id, msg] of Object.entries(source)) if (!(id in catalog)) out[id] = msg;
    }
    process.stdout.write(serialize(out));
    break;
  }
  default:
    console.error("usage: node scripts/i18n.mjs extract|check|format|missing [locale]");
    process.exit(2);
}
