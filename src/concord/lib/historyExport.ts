/**
 * Concord history export writers — the DiscordChatExporter-parity output half of
 * the history tool.
 *
 * These are PURE, synchronous serializers over a fully-assembled
 * {@link ExportModel}: every async concern (decrypting an attachment, resolving
 * a profile, inlining an avatar as a `data:` URI) has already been resolved by
 * the orchestrator into plain fields, so a writer never touches the network,
 * the store, or crypto — which is what lets them be unit-tested against a fixture
 * and lets the HTML they emit be a genuinely self-contained, offline artifact
 * (no `_Files/` sidecar, no live URLs the reader's browser would leak on open).
 *
 * The one thing that makes this export different from a chat log dump: every
 * format leads with the {@link HistoryReport} verdict, so the file states, on
 * its face, how complete the history it contains actually is. An export taken to
 * justify an action carries the proof (or the disclaimer) with it.
 */

import type { HistoryReport } from "@/concord/lib/historyAudit";

// ── The normalized model (assembled by the orchestrator) ─────────────────────

export interface ExportProfile {
  pubkey: string;
  /** Resolved display name (kind-0, `getDisplayName` fallback to a short npub). */
  name: string;
  /** Avatar src: a `data:` URI when embedded offline, an https URL, or undefined. */
  picture?: string;
}

export interface ExportAttachment {
  url: string;
  mime?: string;
  /** Inlined `data:` URI when embedded; absent = link-only (see {@link failed}). */
  dataUri?: string;
  /** An encrypted attachment whose bytes could not be fetched/decrypted for embedding. */
  failed?: boolean;
}

export interface ExportReaction {
  emoji: string;
  count: number;
}

export interface ExportMessage {
  rumorId: string;
  author: string;
  /** Send time (epoch ms) — `created_at*1000 + ms`. */
  ms: number;
  kind: number;
  content: string;
  edited?: boolean;
  /** Thread-root rumor id for a reply, if any. */
  replyTo?: string;
  reactions: ExportReaction[];
  attachments: ExportAttachment[];
}

export interface ExportChannel {
  channelIdHex: string;
  name: string;
  isPrivate: boolean;
  messages: ExportMessage[];
}

export interface ExportModel {
  communityName: string;
  communityIdHex: string;
  /** When the export was produced (epoch ms). */
  generatedAtMs: number;
  /** pubkey → resolved profile. */
  profiles: Record<string, ExportProfile>;
  channels: ExportChannel[];
  /** The completeness verdict this export was taken under. */
  report: HistoryReport;
}

// ── Shared helpers ───────────────────────────────────────────────────────────

/** UTC ISO timestamp — locale-independent so an export is byte-reproducible. */
export function isoTime(ms: number): string {
  return new Date(ms).toISOString();
}

/** A profile's display name, falling back to a short pubkey. */
function nameOf(model: ExportModel, pubkey: string): string {
  const p = model.profiles[pubkey];
  if (p?.name) return p.name;
  return pubkey.length > 12 ? `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}` : pubkey;
}

// ── JSON ─────────────────────────────────────────────────────────────────────

/**
 * The full model as pretty JSON — the machine-readable format, and the one that
 * round-trips every field (report included). Deliberately the whole model, so a
 * downstream analyzer needs nothing this tool knows but didn't write.
 */
export function exportJson(model: ExportModel): string {
  return JSON.stringify(model, null, 2) + "\n";
}

// ── Plain text ─────────────────────────────────────────────────────────────

function reportLines(report: HistoryReport): string[] {
  const lines: string[] = [];
  lines.push(report.ready ? "History completeness: COMPLETE (for this client)" : "History completeness: INCOMPLETE");
  for (const b of report.blockers) lines.push(`  ! ${b.kind}: ${b.detail}`);
  for (const w of report.warnings) lines.push(`  ~ ${w.kind}: ${w.detail}`);
  return lines;
}

/** Human-readable transcript, one channel after another. */
export function exportText(model: ExportModel): string {
  const out: string[] = [];
  out.push(`${model.communityName}`);
  out.push(`Community ${model.communityIdHex}`);
  out.push(`Exported ${isoTime(model.generatedAtMs)}`);
  out.push(...reportLines(model.report));
  out.push("");

  for (const ch of model.channels) {
    out.push("=".repeat(60));
    out.push(`#${ch.name}${ch.isPrivate ? " (private)" : ""} — ${ch.messages.length} message(s)`);
    out.push("=".repeat(60));
    for (const m of ch.messages) {
      const who = nameOf(model, m.author);
      const edited = m.edited ? " (edited)" : "";
      const reply = m.replyTo ? ` [reply→ ${m.replyTo.slice(0, 8)}]` : "";
      out.push(`[${isoTime(m.ms)}] ${who}${reply}${edited}`);
      if (m.content) out.push(indent(m.content));
      for (const a of m.attachments) {
        out.push(indent(a.failed ? `<attachment (undecryptable): ${a.url}>` : `<attachment: ${a.url}>`));
      }
      if (m.reactions.length) {
        out.push(indent(m.reactions.map((r) => `${r.emoji} ${r.count}`).join("  ")));
      }
    }
    out.push("");
  }
  return out.join("\n");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
}

// ── CSV ──────────────────────────────────────────────────────────────────────

function csvCell(value: string): string {
  // Always quote: content routinely carries commas, quotes and newlines, and a
  // quote-always policy is the one that never needs a per-cell decision.
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * One flat CSV across all channels (a `Channel` column, unlike DCE's file-per-
 * channel), so the whole export is one spreadsheet-loadable artifact. Columns
 * mirror DCE's: identity, author, time, content, attachments, reactions.
 */
export function exportCsv(model: ExportModel): string {
  const rows: string[] = [];
  rows.push(["Channel", "AuthorID", "Author", "Date", "Content", "Attachments", "Reactions"].join(","));
  for (const ch of model.channels) {
    for (const m of ch.messages) {
      rows.push(
        [
          csvCell(ch.name),
          csvCell(m.author),
          csvCell(nameOf(model, m.author)),
          csvCell(isoTime(m.ms)),
          csvCell(m.content),
          csvCell(m.attachments.map((a) => a.url).join(" ")),
          csvCell(m.reactions.map((r) => `${r.emoji}:${r.count}`).join(" ")),
        ].join(","),
      );
    }
  }
  return rows.join("\r\n") + "\r\n";
}

// ── HTML ─────────────────────────────────────────────────────────────────────

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape untrusted text for HTML text/attribute context. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/** Escape, linkify bare URLs, and turn newlines into <br> — enough for a transcript. */
function renderContent(text: string): string {
  const escaped = escapeHtml(text);
  const linked = escaped.replace(/https?:\/\/[^\s<]+/g, (url) => `<a href="${url}" rel="noopener noreferrer">${url}</a>`);
  return linked.replace(/\n/g, "<br>");
}

function avatarHtml(model: ExportModel, pubkey: string): string {
  const src = model.profiles[pubkey]?.picture;
  const initial = escapeHtml(nameOf(model, pubkey).slice(0, 1).toUpperCase() || "?");
  if (src) return `<img class="avatar" src="${escapeHtml(src)}" alt="">`;
  return `<span class="avatar avatar-fallback">${initial}</span>`;
}

function attachmentHtml(a: ExportAttachment): string {
  if (a.failed) {
    return `<div class="attachment failed">Attachment could not be decrypted for offline embedding — <a href="${escapeHtml(a.url)}" rel="noopener noreferrer">source link</a></div>`;
  }
  const src = a.dataUri ?? a.url;
  if ((a.mime ?? "").startsWith("image/") || a.dataUri?.startsWith("data:image/")) {
    return `<img class="attachment" src="${escapeHtml(src)}" alt="" loading="lazy">`;
  }
  return `<div class="attachment"><a href="${escapeHtml(src)}" rel="noopener noreferrer">${escapeHtml(a.url)}</a></div>`;
}

function reportHtml(report: HistoryReport): string {
  const items = [
    ...report.blockers.map((b) => `<li class="blocker">${escapeHtml(b.detail)}</li>`),
    ...report.warnings.map((w) => `<li class="warning">${escapeHtml(w.detail)}</li>`),
  ].join("");
  const cls = report.ready ? "complete" : "incomplete";
  const label = report.ready ? "History complete for this client" : "History INCOMPLETE";
  return `<section class="report ${cls}"><h2>${label}</h2>${items ? `<ul>${items}</ul>` : ""}</section>`;
}

const HTML_STYLE = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: #1b1420; color: #e7e0ea; font: 15px/1.5 system-ui, sans-serif; }
header, main { max-width: 900px; margin: 0 auto; padding: 16px; }
header { border-bottom: 1px solid #3a2f42; }
h1 { font-size: 20px; margin: 0 0 4px; }
.meta { color: #a99db4; font-size: 13px; }
.report { margin: 16px 0; padding: 12px 16px; border-radius: 8px; border: 1px solid; }
.report.complete { border-color: #2f6b45; background: #16241c; }
.report.incomplete { border-color: #7a3b3b; background: #2a1a1a; }
.report h2 { font-size: 15px; margin: 0 0 6px; }
.report li.blocker { color: #ff9c9c; }
.report li.warning { color: #ffd79c; }
.channel h2 { position: sticky; top: 0; background: #1b1420; padding: 12px 0 6px; border-bottom: 1px solid #3a2f42; }
.msg { display: flex; gap: 10px; padding: 6px 0; }
.avatar { width: 40px; height: 40px; border-radius: 50%; flex: 0 0 40px; object-fit: cover; background: #3a2f42; }
.avatar-fallback { display: inline-flex; align-items: center; justify-content: center; font-weight: 600; color: #cdbfd6; }
.msg-body { min-width: 0; flex: 1; }
.msg-head { font-size: 14px; }
.author { font-weight: 600; }
.time { color: #8f8398; font-size: 12px; margin-left: 6px; }
.edited, .reply { color: #8f8398; font-size: 12px; }
.content { white-space: normal; overflow-wrap: anywhere; }
.attachment { max-width: 100%; border-radius: 6px; margin-top: 4px; }
.attachment.failed { color: #ffb0b0; font-size: 13px; }
.reactions { margin-top: 4px; }
.reaction { display: inline-block; background: #2c2233; border: 1px solid #3a2f42; border-radius: 10px; padding: 0 8px; margin-right: 4px; font-size: 13px; }
a { color: #c9a9ff; }
`;

function messageHtml(model: ExportModel, m: ExportMessage): string {
  const head =
    `<div class="msg-head"><span class="author">${escapeHtml(nameOf(model, m.author))}</span>` +
    `<span class="time">${escapeHtml(isoTime(m.ms))}</span>` +
    (m.replyTo ? `<span class="reply"> · reply→ ${escapeHtml(m.replyTo.slice(0, 8))}</span>` : "") +
    (m.edited ? `<span class="edited"> · edited</span>` : "") +
    `</div>`;
  const body = m.content ? `<div class="content">${renderContent(m.content)}</div>` : "";
  const atts = m.attachments.map(attachmentHtml).join("");
  const reactions = m.reactions.length
    ? `<div class="reactions">${m.reactions
        .map((r) => `<span class="reaction">${escapeHtml(r.emoji)} ${r.count}</span>`)
        .join("")}</div>`
    : "";
  return `<div class="msg" id="m-${escapeHtml(m.rumorId)}">${avatarHtml(model, m.author)}<div class="msg-body">${head}${body}${atts}${reactions}</div></div>`;
}

/**
 * A single self-contained HTML file: embedded CSS, embedded avatars/images (as
 * `data:` URIs the orchestrator resolved), and the completeness report at the
 * top. Nothing it references lives off the file, so it opens offline and leaks
 * nothing on open.
 */
export function exportHtml(model: ExportModel): string {
  const channels = model.channels
    .map(
      (ch) =>
        `<section class="channel"><h2>#${escapeHtml(ch.name)}${ch.isPrivate ? " 🔒" : ""} <span class="meta">${ch.messages.length} message(s)</span></h2>` +
        ch.messages.map((m) => messageHtml(model, m)).join("") +
        `</section>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(model.communityName)} — Concord export</title>
<style>${HTML_STYLE}</style>
</head>
<body>
<header>
<h1>${escapeHtml(model.communityName)}</h1>
<div class="meta">Community ${escapeHtml(model.communityIdHex)}</div>
<div class="meta">Exported ${escapeHtml(isoTime(model.generatedAtMs))}</div>
</header>
<main>
${reportHtml(model.report)}
${channels}
</main>
</body>
</html>
`;
}

// ── Format registry ──────────────────────────────────────────────────────────

export type ExportFormat = "json" | "txt" | "csv" | "html";

export const EXPORT_FORMATS: Record<ExportFormat, { extension: string; mime: string; write: (m: ExportModel) => string }> = {
  json: { extension: "json", mime: "application/json", write: exportJson },
  txt: { extension: "txt", mime: "text/plain", write: exportText },
  csv: { extension: "csv", mime: "text/csv", write: exportCsv },
  html: { extension: "html", mime: "text/html", write: exportHtml },
};

/** A filesystem-safe base name for the export, matching DCE's guild-channel-date shape. */
export function exportFileName(model: ExportModel, format: ExportFormat): string {
  const safe = model.communityName.replace(/[^\p{L}\p{N}\-_. ]/gu, "_").trim() || "community";
  const date = isoTime(model.generatedAtMs).slice(0, 10);
  return `${safe} [${model.communityIdHex.slice(0, 8)}] ${date}.${EXPORT_FORMATS[format].extension}`;
}
