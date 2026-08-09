import { describe, expect, it } from "vitest";

import { auditHistory, type HistoryReport } from "@/concord/lib/historyAudit";
import {
  EXPORT_FORMATS,
  escapeHtml,
  exportCsv,
  exportFileName,
  exportHtml,
  exportJson,
  exportText,
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
    const m = model();
    const parsed = JSON.parse(exportJson(m));
    expect(parsed.communityName).toBe("Test Community");
    expect(parsed.channels[0].messages).toHaveLength(2);
    expect(parsed.report.ready).toBe(true);
  });
});

describe("exportText", () => {
  it("renders a readable transcript with names and reactions", () => {
    const txt = exportText(model());
    expect(txt).toContain("Test Community");
    expect(txt).toContain("Alice");
    expect(txt).toContain("hello world");
    expect(txt).toContain("👍 2");
    expect(txt).toContain("<attachment: https://blossom/x>");
    expect(txt).toContain("History completeness: COMPLETE");
  });
});

describe("exportCsv", () => {
  it("quotes cells and escapes embedded quotes", () => {
    const m = model();
    m.channels[0].messages[0].content = 'say "hi", now';
    const csv = exportCsv(m);
    expect(csv.split("\r\n")[0]).toBe("Channel,AuthorID,Author,Date,Content,Attachments,Reactions");
    expect(csv).toContain('"say ""hi"", now"');
    expect(csv).toContain('"Alice"');
  });
});

describe("exportHtml", () => {
  it("is self-contained: no non-data external asset URLs for embedded content", () => {
    const html = exportHtml(model());
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Test Community");
    // The embedded avatar + attachment are data URIs, not remote fetches.
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
    const html = exportHtml(model());
    expect(html).toContain('<a href="https://example.com"');
  });

  it("marks an undecryptable attachment instead of embedding it", () => {
    const m = model();
    m.channels[0].messages[0].attachments = [{ url: "https://blossom/enc", failed: true }];
    const html = exportHtml(m);
    expect(html).toContain("could not be decrypted");
  });

  it("shows an incomplete banner when the report is not ready", () => {
    const notReady = auditHistory({
      communityIdHex: "cid",
      control: { incompleteEntities: ["e1"], truncated: false, quorum: true, relays: [{ url: "wss://r", answered: true, failed: false }], channelCount: 1, memberCount: 1 },
      channels: [],
    });
    const html = exportHtml(model({ report: notReady }));
    expect(html).toContain("History INCOMPLETE");
  });
});

describe("format registry + filename", () => {
  it("exposes every format with matching writer", () => {
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
