import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";

import { SlashCommandAutocomplete } from "@/components/chat/SlashCommandAutocomplete";
import { parseBotManifest, type BotCommandEntry } from "@/lib/botCommands";
import concordiaManifest from "@/test/fixtures/concordia-manifest.json";

const BOT_A = "eb1605aff0792094586c53338261e13228a2c4f0b4f109589cf5d510347c2a29";
const BOT_B = "1111111111111111111111111111111111111111111111111111111111111111";

// Bot names come from kind-0 metadata, exactly as the Bot pill resolves them.
vi.mock("@/hooks/useAuthor", () => ({
  useAuthor: (pubkey?: string) => ({
    data: pubkey
      ? { metadata: { name: pubkey === BOT_A ? "Concordia" : "Rival" } }
      : undefined,
  }),
}));

// The bot's name renders through DisplayName (so custom emoji in it resolve),
// which reaches for the per-server nickname. There's no relay behind this test,
// so the scoped lookup resolves to nothing and the global name stands.
vi.mock("@/hooks/useServerProfile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useServerProfile")>()),
  useServerProfile: () => ({ data: null }),
}));

const manifest = parseBotManifest(JSON.stringify(concordiaManifest))!;

function entriesFor(bot: string, names: string[]): BotCommandEntry[] {
  return names.map((name) => ({
    bot,
    command: manifest.commands.find((c) => c.name === name)!,
  }));
}

interface HarnessProps {
  content: string;
  botEntries?: BotCommandEntry[];
  botCount?: number;
  botsLoading?: boolean;
  botRecents?: string[];
  onRunBotCommand?: (entry: BotCommandEntry) => void;
  onRunCommand?: (command: unknown) => void;
}

/** Mounts the menu against a real textarea, the way the composer does. */
function Harness({ content, onRunCommand = vi.fn(), ...rest }: HarnessProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <>
      <textarea ref={ref} value={content} readOnly aria-label="composer" />
      <SlashCommandAutocomplete
        textareaRef={ref}
        content={content}
        canModerate={false}
        capabilities={new Set()}
        onInsertCommand={vi.fn()}
        onRunCommand={onRunCommand as (c: never) => void}
        {...rest}
      />
    </>
  );
}

describe("SlashCommandAutocomplete — bot commands", () => {
  it("lists the app's own commands and each bot's, under that bot's name", () => {
    render(<Harness content="/" botEntries={entriesFor(BOT_A, ["ping", "roll"])} />);

    // The app's built-ins are still there…
    expect(screen.getByText("/shrug")).toBeInTheDocument();
    // …and the bot's commands sit under a section naming the bot.
    expect(screen.getByText("Concordia")).toBeInTheDocument();
    expect(screen.getByText("/ping")).toBeInTheDocument();
    expect(screen.getByText("/roll")).toBeInTheDocument();
    expect(screen.getByText("Round-trip latency check")).toBeInTheDocument();
  });

  it("shows a command's arguments so their shape is visible before picking", () => {
    // `/greet <who> <style> [times]` — the third collapses, so the row can never
    // outgrow the menu.
    render(<Harness content="/" botEntries={entriesFor(BOT_A, ["greet"])} />);
    expect(screen.getByText("who")).toBeInTheDocument();
    expect(screen.getByText("style")).toBeInTheDocument();
    expect(screen.queryByText("times")).not.toBeInTheDocument();
    expect(screen.getByText("+1")).toBeInTheDocument();
  });

  it("collapses a long signature rather than widening the row", () => {
    // `/typetest` declares all six argument types. Spelling them out would push
    // the row past the menu's width and produce a horizontal scrollbar.
    render(<Harness content="/" botEntries={entriesFor(BOT_A, ["typetest"])} />);
    expect(screen.getByText("text")).toBeInTheDocument();
    expect(screen.getByText("count")).toBeInTheDocument();
    expect(screen.getByText("+4")).toBeInTheDocument();
    // The names are not lost, just folded away.
    expect(screen.getByTitle("ratio loud who color")).toBeInTheDocument();
  });

  it("filters bot commands as the command word is typed", () => {
    render(<Harness content="/ro" botEntries={entriesFor(BOT_A, ["ping", "roll"])} />);
    expect(screen.getByText("/roll")).toBeInTheDocument();
    expect(screen.queryByText("/ping")).not.toBeInTheDocument();
  });

  it("keeps two bots' same-named commands as separate, attributable rows", () => {
    render(
      <Harness
        content="/roll"
        botEntries={[...entriesFor(BOT_A, ["roll"]), ...entriesFor(BOT_B, ["roll"])]}
      />,
    );
    // Scoped to the menu's rows: the harness textarea also holds the text "/roll".
    expect(screen.getAllByText("/roll", { selector: "span" })).toHaveLength(2);
    expect(screen.getByText("Concordia")).toBeInTheDocument();
    expect(screen.getByText("Rival")).toBeInTheDocument();
  });

  it("hands the picked command back with the bot that declared it", () => {
    const onRunBotCommand = vi.fn();
    render(
      <Harness
        content="/"
        botEntries={entriesFor(BOT_A, ["ping"])}
        onRunBotCommand={onRunBotCommand}
      />,
    );
    fireEvent.pointerDown(screen.getByText("/ping"));
    expect(onRunBotCommand).toHaveBeenCalledWith(
      expect.objectContaining({ bot: BOT_A, command: expect.objectContaining({ name: "ping" }) }),
    );
  });

  it("selects across sections with one continuous keyboard index", () => {
    const onRunCommand = vi.fn();
    const onRunBotCommand = vi.fn();
    render(
      <Harness
        content="/ping"
        botEntries={entriesFor(BOT_A, ["ping"])}
        onRunCommand={onRunCommand}
        onRunBotCommand={onRunBotCommand}
      />,
    );
    // "/ping" matches no built-in, so the bot's row is the only one and Enter
    // must reach it rather than falling through to the composer's send.
    fireEvent.keyDown(screen.getByLabelText("composer"), { key: "Enter" });
    expect(onRunBotCommand).toHaveBeenCalled();
    expect(onRunCommand).not.toHaveBeenCalled();
  });

  it("surfaces recently used commands first", () => {
    render(
      <Harness
        content="/"
        botEntries={entriesFor(BOT_A, ["ping", "roll"])}
        botRecents={[`${BOT_A}:roll`]}
      />,
    );
    expect(screen.getByText("Recently used")).toBeInTheDocument();
    // Once in recents, once under its bot's section.
    expect(screen.getAllByText("/roll")).toHaveLength(2);
  });

  it("says bots are still resolving rather than showing a false empty", () => {
    render(<Harness content="/zzz" botEntries={[]} botCount={2} botsLoading />);
    expect(screen.getByText("Loading 2 bots…")).toBeInTheDocument();
  });

  it("never eats Enter when there is nothing under the cursor to pick", () => {
    const onRunBotCommand = vi.fn();
    render(
      <Harness
        content="/zzz"
        botEntries={[]}
        botCount={1}
        botsLoading
        onRunBotCommand={onRunBotCommand}
      />,
    );
    const composer = screen.getByLabelText("composer");
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    composer.dispatchEvent(enter);
    // The menu is saying "Loading 1 bot…", but it holds no row to select. Enter
    // belongs to the composer: eating it would swallow an ordinary message and
    // leave the user with no idea why nothing sent.
    expect(enter.defaultPrevented).toBe(false);
    expect(onRunBotCommand).not.toHaveBeenCalled();
  });

  it("says nothing at all in a conversation with no bots", () => {
    // Nothing to wait for, so no loading row: a "/"-leading message here — an
    // emote, a path, a typo — is just a message.
    render(<Harness content="/zzz" botEntries={[]} botCount={0} botsLoading />);
    expect(screen.queryByText(/Looking for bots|Loading/)).not.toBeInTheDocument();
  });

  it("stays out of the way on a surface with no bot discovery", () => {
    // The mesh passes no bot props at all; the menu is exactly as it was.
    render(<Harness content="/" />);
    expect(screen.getByText("/shrug")).toBeInTheDocument();
    expect(screen.queryByText("Concordia")).not.toBeInTheDocument();
    expect(screen.queryByText(/Looking for bots/)).not.toBeInTheDocument();
  });
});

describe("SlashCommandAutocomplete — command options", () => {
  function Options({ content, onInsertCommand }: { content: string; onInsertCommand: (p: { replacement: string }) => void }) {
    const ref = useRef<HTMLTextAreaElement>(null);
    return (
      <>
        <textarea ref={ref} value={content} readOnly aria-label="composer" />
        <SlashCommandAutocomplete
          textareaRef={ref}
          content={content}
          canModerate={false}
          capabilities={new Set()}
          onInsertCommand={onInsertCommand}
          onRunCommand={vi.fn()}
        />
      </>
    );
  }

  it("lists /roll's presets as their name is typed", () => {
    const insert = vi.fn();
    render(<Options content="/roll fire" onInsertCommand={insert} />);
    expect(screen.getByText("fireball")).toBeInTheDocument();
    expect(screen.getByText("8d6")).toBeInTheDocument();
    expect(screen.queryByText("cone-of-cold")).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText("composer"), { key: "Enter" });
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ replacement: "/roll fireball " }));
  });

  it("finds a preset from the command word too", () => {
    render(<Options content="/fireb" onInsertCommand={vi.fn()} />);
    expect(screen.getByText("fireball")).toBeInTheDocument();
  });

  it("lets Enter send a bare /roll and a fully typed preset", () => {
    for (const content of ["/roll ", "/roll fireball"]) {
      const insert = vi.fn();
      const { unmount } = render(<Options content={content} onInsertCommand={insert} />);
      const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
      screen.getByLabelText("composer").dispatchEvent(enter);
      expect(enter.defaultPrevented, content).toBe(false);
      expect(insert).not.toHaveBeenCalled();
      unmount();
    }
  });
});
