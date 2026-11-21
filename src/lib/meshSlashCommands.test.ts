import { describe, expect, it, vi } from "vitest";

import { isMeshSlashCommand } from "@/lib/meshSlashCommands";
import {
  ME_ACTION_PREFIX,
  SLASH_COMMANDS,
  executeSlashCommand,
  findSlashCommand,
  parseSlashCommand,
  type SlashCommandHandlers,
} from "@/lib/slashCommands";

describe("isMeshSlashCommand", () => {
  it("allows the mesh-appropriate commands", () => {
    for (const name of ["me", "shrug", "tableflip", "unflip", "slap", "roll", "mention"]) {
      const cmd = SLASH_COMMANDS.find((c) => c.name === name)!;
      expect(isMeshSlashCommand(cmd)).toBe(true);
    }
  });

  it("excludes moderation / relay-bound commands", () => {
    for (const name of ["kick", "ban", "poll", "thread"]) {
      const cmd = SLASH_COMMANDS.find((c) => c.name === name)!;
      expect(isMeshSlashCommand(cmd)).toBe(false);
    }
  });
});

/**
 * The shared runner, wired exactly as the mesh surface wires it: gated by
 * `isMeshSlashCommand`, with no `onAction` (mesh has no polls/threads/mod).
 * Run a draft string the way the composer does (parse → execute).
 */
function makeMeshHandlers() {
  const handlers: SlashCommandHandlers & {
    sent: string[];
    mentions: (string | undefined)[];
    errors: string[];
    cleared: number;
  } = {
    sent: [],
    mentions: [],
    errors: [],
    cleared: 0,
    send: vi.fn((text: string) => { handlers.sent.push(text); }),
    openMention: vi.fn((prefix?: string) => { handlers.mentions.push(prefix); }),
    clearDraft: vi.fn(() => { handlers.cleared += 1; }),
    onError: vi.fn((message: string) => { handlers.errors.push(message); }),
    isAllowed: isMeshSlashCommand,
  };
  return handlers;
}

async function runMeshDraft(draft: string, handlers: SlashCommandHandlers) {
  const parsed = parseSlashCommand(draft);
  if (!parsed) return false; // passthrough — sent literally by the caller
  await executeSlashCommand(parsed.command, parsed.arg, { canModerate: false, resolvePubkey: () => undefined }, handlers);
  return true;
}

describe("executeSlashCommand (mesh wiring)", () => {
  it("passes through non-command text", async () => {
    const h = makeMeshHandlers();
    expect(await runMeshDraft("hello there", h)).toBe(false);
    expect(await runMeshDraft("not/a/command", h)).toBe(false);
  });

  it("rewrites /me into a marked action line", async () => {
    const h = makeMeshHandlers();
    await runMeshDraft("/me waves", h);
    expect(h.sent).toEqual([`${ME_ACTION_PREFIX}waves`]);
  });

  it("appends the shrug", async () => {
    const h = makeMeshHandlers();
    await runMeshDraft("/shrug", h);
    expect(h.sent[0]).toContain("¯\\_(ツ)_/¯");
  });

  // Regression: argument-less text rewrites picked from the menu produce a
  // `send`, which the old mesh runner silently dropped (left "/t" in the box).
  it("sends /tableflip picked with no argument", async () => {
    const h = makeMeshHandlers();
    await executeSlashCommand(findSlashCommand("tableflip")!, "", { canModerate: false, resolvePubkey: () => undefined }, h);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toContain("┻━┻");
  });

  it("slaps a named target with the classic trout", async () => {
    const h = makeMeshHandlers();
    await runMeshDraft("/slap @anon3f9a#6f70", h);
    expect(h.sent).toEqual([`${ME_ACTION_PREFIX}slaps @anon3f9a#6f70 around a bit with a large trout`]);
  });

  it("opens the mention picker for /slap with no target", async () => {
    const h = makeMeshHandlers();
    await runMeshDraft("/slap", h);
    expect(h.mentions).toEqual(["/slap "]);
    expect(h.sent).toHaveLength(0);
  });

  it("opens the mention picker for /mention", async () => {
    const h = makeMeshHandlers();
    await runMeshDraft("/mention", h);
    expect(h.mentions).toEqual([undefined]);
  });

  it("rejects unsupported commands instead of sending them literally", async () => {
    const h = makeMeshHandlers();
    await runMeshDraft("/kick @someone", h);
    await runMeshDraft("/poll", h);
    expect(h.errors).toHaveLength(2);
    expect(h.sent).toHaveLength(0);
  });

  it("surfaces an error for /me with no action", async () => {
    const h = makeMeshHandlers();
    await runMeshDraft("/me", h);
    expect(h.errors).toHaveLength(1);
    expect(h.sent).toHaveLength(0);
  });
});
