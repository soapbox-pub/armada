/**
 * Concord history export writers.
 *
 * Two formats, both PURE and synchronous over a fully-assembled
 * {@link ExportModel} (every async concern — decrypting an attachment,
 * resolving a profile, inlining an avatar as a `data:` URI — is already resolved
 * into plain fields by the orchestrator):
 *
 *   - {@link exportJson}: the whole model, for machine consumption.
 *   - {@link exportHtml}: a single self-contained file that opens as a MINI
 *     ARMADA — a channel rail down the left, a message pane on the right, and a
 *     little embedded script to switch between them. Nothing it references lives
 *     off the file (inline CSS/JS, `data:` URIs for media), so it opens offline
 *     and leaks nothing on open.
 *
 * Every format leads with the {@link HistoryReport} verdict, so a file taken to
 * justify an action carries the proof (or the disclaimer) of its own
 * completeness with it.
 */

import type { HistoryReport } from "@/concord/lib/historyAudit";

// ── The normalized model (assembled by the orchestrator) ─────────────────────

export interface ExportProfile {
  pubkey: string;
  /** Resolved display name; empty falls back to a short npub at render time. */
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
  /** Community icon, embedded as a `data:` URI when available. */
  icon?: string;
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

/** The full model as pretty JSON — machine-readable, round-trips every field. */
export function exportJson(model: ExportModel): string {
  return JSON.stringify(model, null, 2) + "\n";
}

// ── HTML escaping / content ──────────────────────────────────────────────────

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
  const linked = escaped.replace(/https?:\/\/[^\s<]+/g, (url) => `<a href="${url}" rel="noopener noreferrer" target="_blank">${url}</a>`);
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
    return `<div class="attachment failed">Attachment could not be decrypted for offline embedding — <a href="${escapeHtml(a.url)}" rel="noopener noreferrer" target="_blank">source link</a></div>`;
  }
  const src = a.dataUri ?? a.url;
  if ((a.mime ?? "").startsWith("image/") || a.dataUri?.startsWith("data:image/")) {
    return `<img class="attachment" src="${escapeHtml(src)}" alt="" loading="lazy">`;
  }
  return `<div class="attachment file"><a href="${escapeHtml(src)}" rel="noopener noreferrer" target="_blank">${escapeHtml(a.url)}</a></div>`;
}

function messageHtml(model: ExportModel, m: ExportMessage): string {
  const head =
    `<div class="msg-head"><span class="author">${escapeHtml(nameOf(model, m.author))}</span>` +
    `<span class="time">${escapeHtml(isoTime(m.ms))}</span>` +
    (m.replyTo ? `<span class="tag">reply</span>` : "") +
    (m.edited ? `<span class="tag">edited</span>` : "") +
    `</div>`;
  const body = m.content ? `<div class="content">${renderContent(m.content)}</div>` : "";
  const atts = m.attachments.map(attachmentHtml).join("");
  const reactions = m.reactions.length
    ? `<div class="reactions">${m.reactions
        .map((r) => `<span class="reaction">${escapeHtml(r.emoji)} <b>${r.count}</b></span>`)
        .join("")}</div>`
    : "";
  return `<div class="msg" id="m-${escapeHtml(m.rumorId)}">${avatarHtml(model, m.author)}<div class="msg-body">${head}${body}${atts}${reactions}</div></div>`;
}

// ── The completeness banner ──────────────────────────────────────────────────

function reportHtml(report: HistoryReport): string {
  const items = [
    ...report.blockers.map((b) => `<li class="blocker">${escapeHtml(b.detail)}</li>`),
    ...report.warnings.map((w) => `<li class="warning">${escapeHtml(w.detail)}</li>`),
  ].join("");
  const cls = report.ready ? "complete" : "incomplete";
  const label = report.ready ? "History complete for this client" : "History INCOMPLETE";
  // A <details> keeps it out of the way when clean and unfoldable when it isn't.
  return (
    `<details class="report ${cls}"${report.ready ? "" : " open"}>` +
    `<summary><span class="dot"></span>${label}</summary>` +
    (items ? `<ul>${items}</ul>` : `<p class="muted">Every channel reached its floor and the control plane is fully accounted for.</p>`) +
    `</details>`
  );
}

// ── The self-contained mini-Armada document ──────────────────────────────────

const APP_STYLE = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; background: #17121d; color: #ece6f0; font: 15px/1.5 system-ui, -apple-system, sans-serif; }
a { color: #c9a9ff; }
.muted { color: #9a8fa6; }
.app { display: flex; height: 100vh; }
.sidebar { width: 260px; flex: 0 0 260px; background: #120e17; border-right: 1px solid #2c2435; display: flex; flex-direction: column; }
.community { display: flex; align-items: center; gap: 10px; padding: 16px; border-bottom: 1px solid #2c2435; font-weight: 700; }
.community img { width: 32px; height: 32px; border-radius: 9px; object-fit: cover; }
.community .fallback { width: 32px; height: 32px; border-radius: 9px; background: #34294a; display: inline-flex; align-items: center; justify-content: center; font-weight: 700; }
.channels { flex: 1; overflow-y: auto; padding: 8px; }
.ch { display: flex; width: 100%; align-items: center; gap: 6px; padding: 7px 10px; border: 0; border-radius: 7px; background: transparent; color: #b9adc6; font: inherit; text-align: left; cursor: pointer; }
.ch:hover { background: #221a2e; color: #ece6f0; }
.ch.active { background: #2c2138; color: #fff; }
.ch .hash { color: #6f6480; font-weight: 700; }
.ch .count { margin-left: auto; font-size: 12px; color: #7d7189; }
.ch .lock { font-size: 11px; }
.exported { padding: 10px 16px; border-top: 1px solid #2c2435; font-size: 11px; color: #7d7189; }
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.topbar { display: flex; align-items: center; gap: 10px; padding: 12px 20px; border-bottom: 1px solid #2c2435; }
.topbar .title { font-weight: 700; }
.report { margin-left: auto; font-size: 13px; border-radius: 8px; padding: 4px 10px; border: 1px solid transparent; }
.report summary { cursor: pointer; list-style: none; display: inline-flex; align-items: center; gap: 8px; }
.report summary::-webkit-details-marker { display: none; }
.report .dot { width: 9px; height: 9px; border-radius: 50%; }
.report.complete { background: #16241c; border-color: #2f6b45; }
.report.complete .dot { background: #4ade80; }
.report.incomplete { background: #2a1a1a; border-color: #7a3b3b; }
.report.incomplete .dot { background: #ff8f8f; }
.report ul { margin: 8px 0 2px; padding-left: 18px; }
.report li.blocker { color: #ff9c9c; }
.report li.warning { color: #ffd79c; }
.panes { flex: 1; overflow-y: auto; }
.pane { display: none; padding: 12px 20px 40px; }
.pane.active { display: block; }
.empty { color: #7d7189; padding: 24px 0; text-align: center; }
.msg { display: flex; gap: 12px; padding: 7px 0; }
.avatar { width: 40px; height: 40px; border-radius: 50%; flex: 0 0 40px; object-fit: cover; background: #34294a; }
.avatar-fallback { display: inline-flex; align-items: center; justify-content: center; font-weight: 600; color: #d8ccdf; }
.msg-body { min-width: 0; flex: 1; }
.msg-head { display: flex; align-items: baseline; gap: 8px; }
.author { font-weight: 600; }
.time { color: #8f8398; font-size: 12px; }
.tag { color: #8f8398; font-size: 11px; background: #241c30; border-radius: 6px; padding: 0 6px; }
.content { overflow-wrap: anywhere; }
.attachment { max-width: min(400px, 100%); border-radius: 8px; margin-top: 6px; display: block; }
.attachment.file { font-size: 13px; }
.attachment.failed { color: #ffb0b0; font-size: 13px; }
.reactions { margin-top: 5px; }
.reaction { display: inline-block; background: #241c30; border: 1px solid #372b47; border-radius: 12px; padding: 1px 9px; margin-right: 5px; font-size: 13px; }
`;

const SWITCH_SCRIPT = `
(function () {
  var buttons = Array.prototype.slice.call(document.querySelectorAll('.ch'));
  var panes = Array.prototype.slice.call(document.querySelectorAll('.pane'));
  var title = document.getElementById('pane-title');
  function select(id, name) {
    panes.forEach(function (p) { p.classList.toggle('active', p.getAttribute('data-pane') === id); });
    buttons.forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-ch') === id); });
    if (title && name != null) title.textContent = name;
  }
  buttons.forEach(function (b) {
    b.addEventListener('click', function () { select(b.getAttribute('data-ch'), b.getAttribute('data-name')); });
  });
  if (buttons.length) select(buttons[0].getAttribute('data-ch'), buttons[0].getAttribute('data-name'));
})();
`;

function communityGlyph(model: ExportModel): string {
  if (model.icon) return `<img src="${escapeHtml(model.icon)}" alt="">`;
  const initial = escapeHtml((model.communityName.slice(0, 1) || "#").toUpperCase());
  return `<span class="fallback">${initial}</span>`;
}

function channelButton(ch: ExportChannel): string {
  return (
    `<button class="ch" data-ch="${escapeHtml(ch.channelIdHex)}" data-name="${escapeHtml(ch.name)}">` +
    `<span class="hash">${ch.isPrivate ? "🔒" : "#"}</span>` +
    `<span class="name">${escapeHtml(ch.name)}</span>` +
    `<span class="count">${ch.messages.length}</span>` +
    `</button>`
  );
}

function channelPane(model: ExportModel, ch: ExportChannel): string {
  const body = ch.messages.length
    ? ch.messages.map((m) => messageHtml(model, m)).join("")
    : `<div class="empty">No messages in this channel.</div>`;
  return `<section class="pane" data-pane="${escapeHtml(ch.channelIdHex)}">${body}</section>`;
}

/**
 * A single self-contained HTML file that opens as a mini Armada: a channel rail,
 * a message pane, and an embedded switch script. Fully offline — inline CSS/JS
 * and `data:` URIs for every image the orchestrator resolved.
 */
export function exportHtml(model: ExportModel): string {
  const channels = model.channels;
  const rail = channels.map(channelButton).join("");
  const panes = channels.map((ch) => channelPane(model, ch)).join("");
  const firstName = channels[0]?.name ?? "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(model.communityName)} — Concord export</title>
<style>${APP_STYLE}</style>
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="community">${communityGlyph(model)}<span>${escapeHtml(model.communityName)}</span></div>
    <nav class="channels">${rail || '<div class="empty">No channels</div>'}</nav>
    <div class="exported">Exported ${escapeHtml(isoTime(model.generatedAtMs))}<br>${escapeHtml(model.communityIdHex.slice(0, 16))}…</div>
  </aside>
  <main class="main">
    <div class="topbar">
      <span class="title"><span class="hash muted">#</span> <span id="pane-title">${escapeHtml(firstName)}</span></span>
      ${reportHtml(model.report)}
    </div>
    <div class="panes">${panes || '<div class="empty">Nothing to show.</div>'}</div>
  </main>
</div>
<script>${SWITCH_SCRIPT}</script>
</body>
</html>
`;
}

// ── Format registry ──────────────────────────────────────────────────────────

export type ExportFormat = "html" | "json";

export const EXPORT_FORMATS: Record<ExportFormat, { extension: string; mime: string; write: (m: ExportModel) => string }> = {
  html: { extension: "html", mime: "text/html", write: exportHtml },
  json: { extension: "json", mime: "application/json", write: exportJson },
};

/** A filesystem-safe base name for the export (community-id-date shape). */
export function exportFileName(model: ExportModel, format: ExportFormat): string {
  const safe = model.communityName.replace(/[^\p{L}\p{N}\-_. ]/gu, "_").trim() || "community";
  const date = isoTime(model.generatedAtMs).slice(0, 10);
  return `${safe} [${model.communityIdHex.slice(0, 8)}] ${date}.${EXPORT_FORMATS[format].extension}`;
}
