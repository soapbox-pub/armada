import { fireEvent, render, screen } from "@testing-library/react";
import { nip19 } from "nostr-tools";
import { describe, expect, it, vi } from "vitest";

import { BotCommandComposer } from "@/components/chat/BotCommandComposer";
import { parseBotManifest, type BotCommandEntry } from "@/lib/botCommands";
import concordiaManifest from "@/test/fixtures/concordia-manifest.json";

// Avatars read the full profile for Ultra; the roster names are what these tests assert on.
vi.mock("@/hooks/useAuthor", () => ({ useAuthor: () => ({ data: undefined }) }));

const BOT = "eb1605aff0792094586c53338261e13228a2c4f0b4f109589cf5d510347c2a29";
const MEMBER = "1111111111111111111111111111111111111111111111111111111111111111";
/** The bech32 encoding of MEMBER, derived rather than transcribed. */
const MEMBER_NPUB = nip19.npubEncode(MEMBER);

const manifest = parseBotManifest(JSON.stringify(concordiaManifest))!;

/** A real command from the reference bot's live manifest. */
function entry(name: string): BotCommandEntry {
  const command = manifest.commands.find((c) => c.name === name);
  if (!command) throw new Error(`no such command: ${name}`);
  return { bot: BOT, command };
}

function mount(name: string) {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  render(
    <BotCommandComposer
      entry={entry(name)}
      memberPubkeys={[MEMBER]}
      profiles={{ [BOT]: { name: "Concordia" }, [MEMBER]: { name: "Alice" } }}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />,
  );
  return { onSubmit, onCancel };
}

describe("BotCommandComposer", () => {
  it("names the command and the bot that will run it", () => {
    mount("roll");
    expect(screen.getByText("/roll")).toBeInTheDocument();
    expect(screen.getByText("Concordia")).toBeInTheDocument();
  });

  it("renders one field per declared argument", () => {
    mount("announce");
    expect(screen.getByLabelText("title")).toBeInTheDocument();
    expect(screen.getByLabelText("body")).toBeInTheDocument();
  });

  it("assembles canonical text, quoting what the user never had to quote", () => {
    const { onSubmit } = mount("announce");
    fireEvent.change(screen.getByLabelText("title"), { target: { value: "Big news" } });
    fireEvent.change(screen.getByLabelText("body"), { target: { value: "Meeting at 5pm" } });
    fireEvent.keyDown(screen.getByLabelText("body"), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith('/announce "Big news" "Meeting at 5pm"');
  });

  it("sends from its own send button, not only from the Enter key", () => {
    const { onSubmit } = mount("announce");
    fireEvent.change(screen.getByLabelText("title"), { target: { value: "Big news" } });
    fireEvent.change(screen.getByLabelText("body"), { target: { value: "Meeting at 5pm" } });
    fireEvent.click(screen.getByLabelText("Send command"));
    expect(onSubmit).toHaveBeenCalledWith('/announce "Big news" "Meeting at 5pm"');
  });

  it("holds the send button to the same validation as the Enter key", () => {
    const { onSubmit } = mount("announce");
    fireEvent.change(screen.getByLabelText("title"), { target: { value: "Only a title" } });
    fireEvent.click(screen.getByLabelText("Send command"));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByLabelText("body")).toHaveFocus();
  });

  it("walks forward on Enter and only sends from the last field", () => {
    const { onSubmit } = mount("announce");
    const title = screen.getByLabelText("title");
    fireEvent.change(title, { target: { value: "Heads up" } });
    fireEvent.keyDown(title, { key: "Enter" });
    // Enter on a middle field advances rather than sending a half-built command.
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByLabelText("body")).toHaveFocus();
  });

  it("refuses to send while a required argument is empty", () => {
    const { onSubmit } = mount("announce");
    fireEvent.change(screen.getByLabelText("title"), { target: { value: "Only a title" } });
    fireEvent.keyDown(screen.getByLabelText("body"), { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByLabelText("body")).toHaveFocus();
  });

  it("sends a command whose only argument is optional and left blank", () => {
    const { onSubmit } = mount("roll");
    fireEvent.keyDown(screen.getByLabelText("sides"), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("/roll");
  });

  it("keeps a numeric field numeric as it is typed", () => {
    mount("roll");
    const sides = screen.getByLabelText("sides");
    // A desktop keyboard can type anything, so the field filters as it goes and
    // a bad value never reaches the wire in the first place.
    fireEvent.change(sides, { target: { value: "2a0" } });
    expect(sides).toHaveValue("20");
  });

  it("offers a choice argument's values rather than making the user recall them", () => {
    const { onSubmit } = mount("react");
    const emoji = screen.getByLabelText("emoji");
    // The only field is a choice, so its menu is already open on mount.
    // An optional choice can also simply be skipped.
    expect(screen.getByText("(skip)")).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByText("🔥"));
    fireEvent.keyDown(emoji, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("/react 🔥");
  });

  it("picks a member for a user argument and sends their npub, not their name", () => {
    const { onSubmit } = mount("greet");
    const who = screen.getByLabelText("who");
    fireEvent.focus(who);
    fireEvent.pointerDown(screen.getByText("Alice"));
    // The field shows the name; the wire carries the canonical npub.
    expect(who).toHaveValue("Alice");

    // Picking a member advances to `style` and opens its menu automatically.
    fireEvent.pointerDown(screen.getByText("pirate"));

    fireEvent.keyDown(screen.getByLabelText("times"), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith(`/greet ${MEMBER_NPUB} pirate`);
  });

  it("refuses a value that is under the field's character cap but over the wire's byte cap", () => {
    const { onSubmit } = mount("announce");
    // 400 emoji: well under maxLength (which counts UTF-16 units), but 1600
    // bytes — over the 1024-byte wire cap. Sending it would publish the routing
    // tag for a command the bot is required to ignore, so the user would see
    // nothing happen and never learn why.
    fireEvent.change(screen.getByLabelText("title"), { target: { value: "🙂".repeat(400) } });
    fireEvent.change(screen.getByLabelText("body"), { target: { value: "ok" } });
    fireEvent.keyDown(screen.getByLabelText("body"), { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("closes a member picker as soon as focus leaves the field", () => {
    mount("greet");
    const who = screen.getByLabelText("who");
    fireEvent.focus(who);
    expect(screen.getByText("Alice")).toBeInTheDocument();
    // Arrowing (or clicking) onto another field must not leave the picker
    // floating over a field it no longer belongs to.
    fireEvent.blur(who);
    expect(screen.queryByText("Alice")).not.toBeInTheDocument();
  });

  it("closes a choice drop-up as soon as focus leaves the field", () => {
    mount("greet");
    const style = screen.getByLabelText("style");
    fireEvent.pointerDown(style);
    expect(screen.getByText("pirate")).toBeInTheDocument();
    fireEvent.blur(style);
    expect(screen.queryByText("pirate")).not.toBeInTheDocument();
  });

  it("orders the user picker by recent activity, then roster order", () => {
    const M1 = "1".repeat(64);
    const M2 = "2".repeat(64);
    const M3 = "3".repeat(64);
    render(
      <BotCommandComposer
        entry={entry("greet")}
        memberPubkeys={[M1, M2, M3]}
        profiles={{ [M1]: { name: "Alpha" }, [M2]: { name: "Bravo" }, [M3]: { name: "Charlie" } }}
        recentAuthors={[M3, M1]} // Charlie spoke most recently, then Alpha; Bravo is quiet
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.focus(screen.getByLabelText("who"));
    const names = ["Alpha", "Bravo", "Charlie"];
    const order = screen
      .getAllByRole("button")
      .map((b) => names.find((n) => b.textContent?.includes(n)))
      .filter((n): n is string => Boolean(n));
    expect(order).toEqual(["Charlie", "Alpha", "Bravo"]);
  });

  it("opens a choice's menu when you advance into it from the previous field", () => {
    // `/calc <a:number> <op:choice> <b:number>` — advancing off `a` should land
    // inside `op`'s dropdown, not on a closed trigger.
    mount("calc");
    expect(screen.queryByText("add")).not.toBeInTheDocument(); // op closed at first
    const a = screen.getByLabelText("a");
    fireEvent.change(a, { target: { value: "3" } });
    fireEvent.keyDown(a, { key: "Enter" }); // advance to op
    expect(screen.getByText("add")).toBeInTheDocument();
    expect(screen.getByText("mul")).toBeInTheDocument();
  });

  it("opens the first field's menu on mount when it is a selector", () => {
    // `/react [emoji:choice]` — the only field is a choice, so its options show
    // immediately rather than making the user click the trigger first.
    mount("react");
    expect(screen.getByText("🔥")).toBeInTheDocument();
  });

  it("abandons the command on Escape", () => {
    const { onCancel } = mount("roll");
    fireEvent.keyDown(screen.getByLabelText("sides"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
  });

  it("abandons the command when backspacing out of the first field", () => {
    const { onCancel } = mount("announce");
    fireEvent.keyDown(screen.getByLabelText("title"), { key: "Backspace" });
    expect(onCancel).toHaveBeenCalled();
  });
});
