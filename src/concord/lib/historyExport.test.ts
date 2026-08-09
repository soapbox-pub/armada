import { describe, expect, it } from "vitest";

import { auditHistory, type HistoryReport } from "@/concord/lib/historyAudit";
import {
  EXPORT_FORMATS,
  escapeHtml,
  exportFileName,
  exportHtml,
  exportJson,
  isoTime,
  type ExportModel,
} from "@/concord/lib/historyExport";

function report(): HistoryReport {
  return auditHistory({
    communityIdHex: "cid",
    control: { incompleteEntities: [], truncated: false, quorum: true, relays: [{ url: "wss://r", answered: true, failed: false }], channelCount: 1, memberCount: 2 },
    channels: [],
  });
}

function model(over: Partial<ExportModel> = {}): ExportModel {
  return {
    communityName: over.communityName ?? "Test Community",
    communityIdHex: over.communityIdHex ?? "cid1234deadbeef",
    generatedAtMs: over.generatedAtMs ?? Date.parse("2026-01-02T03:04:05.000Z"),
    profiles: over.profiles ?? {
      aa: { pubkey: "aa", name: "Alice", picture: "data:image/png;base64,AAAA" },
      bb: { pubkey: "bb", name: "Bob" },
    },
    channels: over.channels ?? [
      {
        channelIdHex: "ch1",
        name: "general",
        isPrivate: false,
        messages: [
          { rumorId: "m1", author: "aa", ms: Date.parse("2026-01-01T00:00:00Z"), kind: 9, content: "hello world", reactions: [{ emoji: "👍", count: 2 }], attachments: [] },
          { rumorId: "m2", author: "bb", ms: Date.parse("2026-01-01T00:01:00Z"), kind: 9, content: "check https://example.com", edited: true, reactions: [], attachments: [{ url: "https://blossom/x", mime: "image/png", dataUri: "data:image/png;base64,BBBB" }] },
        ],
      },
      { channelIdHex: "ch2", name: "random", isPrivate: true, messages: [] },
    ],
    report: over.report ?? report(),
  };
}

describe("isoTime", () => {
  it("formats UTC deterministically", () => {
    expect(isoTime(Date.parse("2026-01-02T03:04:05Z"))).toBe("2026-01-02T03:04:05.000Z");
  });
});

describe("escapeHtml", () => {
  it("neutralizes markup", () => {
    expect(escapeHtml(`<script>&"'`)).toBe("&lt;script&gt;&amp;&quot;&#39;");
  });
});

describe("exportJson", () => {
  it("round-trips the whole model", () => {
    const parsed = JSON.parse(exportJson(model()));
    expect(parsed.communityName).toBe("Test Community");
    expect(parsed.channels[0].messages).toHaveLength(2);
    expect(parsed.report.ready).toBe(true);
  });
});

describe("exportHtml (mini-Armada)", () => {
  it("renders a channel rail and a pane per channel", () => {
    const html = exportHtml(model());
    expect(html).toContain("<!doctype html>");
    // A rail button + a pane, keyed by channel id, for each channel.
    expect(html).toContain('data-ch="ch1"');
    expect(html).toContain('data-ch="ch2"');
    expect(html).toContain('data-pane="ch1"');
    expect(html).toContain('data-pane="ch2"');
    // A private channel is marked.
    expect(html).toContain("🔒");
    // The embedded switch script makes it interactive with no external assets.
    expect(html).toContain("addEventListener('click'");
  });

  it("is self-contained: embedded media are data URIs", () => {
    const html = exportHtml(model());
    expect(html).toContain("data:image/png;base64,AAAA");
    expect(html).toContain("data:image/png;base64,BBBB");
  });

  it("escapes hostile content so an export can't XSS its viewer", () => {
    const m = model();
    m.channels[0].messages[0].content = "<img src=x onerror=alert(1)>";
    m.profiles.aa.name = "<b>pwn</b>";
    const html = exportHtml(m);
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;b&gt;pwn&lt;/b&gt;");
  });

  it("linkifies bare URLs in content", () => {
    expect(exportHtml(model())).toContain('<a href="https://example.com"');
  });

  it("marks an undecryptable attachment instead of embedding it", () => {
    const m = model();
    m.channels[0].messages[0].attachments = [{ url: "https://blossom/enc", failed: true }];
    expect(exportHtml(m)).toContain("could not be decrypted");
  });

  it("shows an incomplete banner when the report is not ready", () => {
    const notReady = auditHistory({
      communityIdHex: "cid",
      control: { incompleteEntities: ["e1"], truncated: false, quorum: true, relays: [{ url: "wss://r", answered: true, failed: false }], channelCount: 1, memberCount: 1 },
      channels: [],
    });
    expect(exportHtml(model({ report: notReady }))).toContain("History INCOMPLETE");
  });

  it("shows an empty-channel placeholder", () => {
    expect(exportHtml(model())).toContain("No messages in this channel.");
  });
});

describe("format registry + filename", () => {
  it("exposes only html and json", () => {
    expect(Object.keys(EXPORT_FORMATS).sort()).toEqual(["html", "json"]);
    const m = model();
    expect(EXPORT_FORMATS.json.write(m)).toBe(exportJson(m));
    expect(EXPORT_FORMATS.html.mime).toBe("text/html");
  });

  it("builds a filesystem-safe name", () => {
    const name = exportFileName(model({ communityName: "My/Cool: Room" }), "html");
    expect(name).not.toMatch(/[/:]/);
    expect(name.endsWith(".html")).toBe(true);
    expect(name).toContain("2026-01-02");
  });
});
