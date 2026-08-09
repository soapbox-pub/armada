/**
 * Concord history export writer.
 *
 * ONE download: a single self-contained HTML file that opens as a MINI ARMADA
 * and carries every view of the same rumor-derived model inside it, switched by
 * a tab bar:
 *
 *   - Chat: a channel rail down the left, a message pane on the right.
 *   - Text: a flat plaintext transcript.
 *   - JSON: the whole model, pretty-printed, for machine consumption.
 *
 * Nothing it references lives off the file (inline CSS/JS, `data:` URIs for
 * media), so it opens offline and leaks nothing on open.
 *
 * The completeness verdict is deliberately NOT baked into the file: it is a
 * property of the client that produced the export, shown once in the app before
 * download, not a permanent notice stamped on the artifact. Everything here is
 * PURE and synchronous over a fully-assembled {@link ExportModel}, which the
 * orchestrator builds from the LOCAL RUMOR STORE after the sweep populates it.
 */

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
  /** Send time (epoch ms): `created_at*1000 + ms`. */
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
  /** pubkey to resolved profile. */
  profiles: Record<string, ExportProfile>;
  channels: ExportChannel[];
}

// ── Shared helpers ───────────────────────────────────────────────────────────

/** UTC ISO timestamp, locale-independent so an export is byte-reproducible. */
export function isoTime(ms: number): string {
  return new Date(ms).toISOString();
}

/** A profile's display name, falling back to a short pubkey. */
function nameOf(model: ExportModel, pubkey: string): string {
  const p = model.profiles[pubkey];
  if (p?.name) return p.name;
  return pubkey.length > 12 ? `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}` : pubkey;
}

// ── JSON (embedded into the HTML; not a separate download) ───────────────────

/** The full model as pretty JSON. Round-trips every field. */
export function exportJson(model: ExportModel): string {
  return JSON.stringify(model, null, 2) + "\n";
}

// ── Plaintext transcript (embedded into the HTML) ────────────────────────────

/** A flat plaintext transcript of the model, for the HTML's Text tab. */
export function buildTranscript(model: ExportModel): string {
  const out: string[] = [];
  out.push(model.communityName);
  out.push(`Community ${model.communityIdHex}`);
  out.push(`Exported ${isoTime(model.generatedAtMs)}`);
  out.push("");
  for (const ch of model.channels) {
    out.push("=".repeat(56));
    out.push(`#${ch.name}${ch.isPrivate ? " (private)" : ""}  ${ch.messages.length} message(s)`);
    out.push("=".repeat(56));
    for (const m of ch.messages) {
      const who = nameOf(model, m.author);
      const flags = [m.replyTo ? "reply" : "", m.edited ? "edited" : ""].filter(Boolean).join(", ");
      out.push(`[${isoTime(m.ms)}] ${who}${flags ? ` (${flags})` : ""}`);
      if (m.content) out.push(m.content.split("\n").map((l) => `    ${l}`).join("\n"));
      for (const a of m.attachments) {
        out.push(`    <attachment${a.failed ? " (undecryptable)" : ""}: ${a.url}>`);
      }
      if (m.reactions.length) out.push(`    ${m.reactions.map((r) => `${r.emoji} ${r.count}`).join("  ")}`);
    }
    out.push("");
  }
  return out.join("\n");
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

/** Escape, linkify bare URLs, and turn newlines into <br>. Enough for a transcript. */
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
    return `<div class="attachment failed">Attachment could not be decrypted for offline embedding. <a href="${escapeHtml(a.url)}" rel="noopener noreferrer" target="_blank">Source link</a></div>`;
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

// ── The self-contained mini-Armada document ──────────────────────────────────

const APP_STYLE = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; background: #17121d; color: #ece6f0; font: 15px/1.5 system-ui, -apple-system, sans-serif; display: flex; flex-direction: column; }
a { color: #c9a9ff; }
.muted { color: #9a8fa6; }
.tabbar { display: flex; align-items: center; gap: 4px; padding: 8px 12px; border-bottom: 1px solid #2c2435; background: #120e17; }
.tab { border: 0; background: transparent; color: #b9adc6; font: inherit; font-size: 14px; padding: 5px 12px; border-radius: 7px; cursor: pointer; }
.tab:hover { background: #221a2e; color: #ece6f0; }
.tab.active { background: #2c2138; color: #fff; }
.views { flex: 1; min-height: 0; position: relative; }
.view { display: none; height: 100%; }
.view.active { display: block; }
.view-text.active, .view-json.active { overflow: auto; padding: 16px 20px; }
.view-text pre, .view-json pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 12.5px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; color: #d8ccdf; }
.view-chat.active { overflow: hidden; }
.app { display: flex; height: 100%; }
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
.exported { padding: 10px 16px; border-top: 1px solid #2c2435; font-size: 11px; color: #7d7189; }
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.topbar { display: flex; align-items: center; gap: 10px; padding: 12px 20px; border-bottom: 1px solid #2c2435; }
.topbar .title { font-weight: 700; }
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
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));
  var views = Array.prototype.slice.call(document.querySelectorAll('.view'));
  function showView(v) {
    views.forEach(function (x) { x.classList.toggle('active', x.getAttribute('data-view') === v); });
    tabs.forEach(function (t) { t.classList.toggle('active', t.getAttribute('data-view') === v); });
  }
  tabs.forEach(function (t) { t.addEventListener('click', function () { showView(t.getAttribute('data-view')); }); });

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
 * A single self-contained HTML file: a Chat / Text / JSON tab bar over one
 * rumor-derived model. Fully offline (inline CSS/JS, `data:` URIs for media).
 */
export function exportHtml(model: ExportModel): string {
  const channels = model.channels;
  const rail = channels.map(channelButton).join("");
  const panes = channels.map((ch) => channelPane(model, ch)).join("");
  const firstName = channels[0]?.name ?? "";
  const transcript = escapeHtml(buildTranscript(model));
  const json = escapeHtml(exportJson(model));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(model.communityName)} Concord export</title>
<style>${APP_STYLE}</style>
</head>
<body>
<div class="tabbar">
  <button class="tab active" data-view="chat">Chat</button>
  <button class="tab" data-view="text">Text</button>
  <button class="tab" data-view="json">JSON</button>
</div>
<div class="views">
  <section class="view view-chat active" data-view="chat">
    <div class="app">
      <aside class="sidebar">
        <div class="community">${communityGlyph(model)}<span>${escapeHtml(model.communityName)}</span></div>
        <nav class="channels">${rail || '<div class="empty">No channels</div>'}</nav>
        <div class="exported">Exported ${escapeHtml(isoTime(model.generatedAtMs))}<br>${escapeHtml(model.communityIdHex.slice(0, 16))}…</div>
      </aside>
      <main class="main">
        <div class="topbar"><span class="title"><span class="hash muted">#</span> <span id="pane-title">${escapeHtml(firstName)}</span></span></div>
        <div class="panes">${panes || '<div class="empty">Nothing to show.</div>'}</div>
      </main>
    </div>
  </section>
  <section class="view view-text" data-view="text"><pre>${transcript}</pre></section>
  <section class="view view-json" data-view="json"><pre>${json}</pre></section>
</div>
<script>${SWITCH_SCRIPT}</script>
</body>
</html>
`;
}

// ── Format registry ──────────────────────────────────────────────────────────

export type ExportFormat = "html";

export const EXPORT_FORMATS: Record<ExportFormat, { extension: string; mime: string; write: (m: ExportModel) => string }> = {
  html: { extension: "html", mime: "text/html", write: exportHtml },
};

/** A filesystem-safe base name for the export (community-id-date shape). */
export function exportFileName(model: ExportModel, format: ExportFormat): string {
  const safe = model.communityName.replace(/[^\p{L}\p{N}\-_. ]/gu, "_").trim() || "community";
  const date = isoTime(model.generatedAtMs).slice(0, 10);
  return `${safe} [${model.communityIdHex.slice(0, 8)}] ${date}.${EXPORT_FORMATS[format].extension}`;
}
