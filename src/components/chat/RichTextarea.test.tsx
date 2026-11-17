import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { nip19 } from "nostr-tools";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useMentionLabels", () => ({
  useMentionLabels: () => () => "@Alice",
}));

import { RichTextarea } from "@/components/chat/RichTextarea";
import { useRichText } from "@/components/chat/useRichText";

const ref = `nostr:${nip19.npubEncode("a".repeat(64))}`;

function Field({ initial, onValue }: { initial: string; onValue: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const rich = useRichText({
    value,
    onValueChange: (v) => {
      setValue(v);
      onValue(v);
    },
    textareaRef,
  });
  return (
    <div className="relative">
      <RichTextarea rich={rich} aria-label="field" />
    </div>
  );
}

afterEach(cleanup);

describe("RichTextarea", () => {
  it("shows a mention by name and keeps the canonical text", () => {
    const onValue = vi.fn();
    render(<Field initial={`hi ${ref} `} onValue={onValue} />);
    const field = screen.getByLabelText("field") as HTMLTextAreaElement;
    expect(field.value).toBe("hi @Alice ");

    fireEvent.change(field, { target: { value: "hi @Alice there", selectionStart: 15, selectionEnd: 15 } });
    expect(onValue).toHaveBeenLastCalledWith(`hi ${ref} there`);
    expect(field.value).toBe("hi @Alice there");
  });

  it("formats the selection on Ctrl+B", () => {
    const onValue = vi.fn();
    render(<Field initial="say hi" onValue={onValue} />);
    const field = screen.getByLabelText("field") as HTMLTextAreaElement;
    field.focus();
    field.setSelectionRange(4, 6);
    fireEvent.keyDown(field, { key: "b", ctrlKey: true });
    expect(onValue).toHaveBeenLastCalledWith("say **hi**");
    expect(field.value).toBe("say **hi**");
  });

  it("lays the text out unsplit in the overlay", () => {
    const { container } = render(<Field initial="a **b**" onValue={() => {}} />);
    const inner = container.querySelector(".rt-overlay")!.firstElementChild!;
    expect(inner.firstChild).toBeInstanceOf(Text);
    expect(inner.firstChild!.textContent).toBe("a **b**\u200b");
  });
});

/** A fixed-pitch layout: 10px per character, 8 characters to a 20px line; a drawn piece's text sits where the piece is. */
function fixedPitchRects(this: Range): DOMRectList {
  const piece = this.startContainer.parentElement?.closest<HTMLElement>(".rt-piece");
  if (piece) {
    const x = parseFloat(piece.style.left) + this.startOffset * 10;
    return [new DOMRect(x, parseFloat(piece.style.top), (this.endOffset - this.startOffset) * 10, 20)] as unknown as DOMRectList;
  }
  const rects: DOMRect[] = [];
  for (let i = this.startOffset; i < this.endOffset; i++) {
    const x = (i % 8) * 10;
    const y = Math.floor(i / 8) * 20;
    const last = rects[rects.length - 1];
    if (last && last.y === y) rects[rects.length - 1] = new DOMRect(last.x, y, x + 10 - last.x, 20);
    else rects.push(new DOMRect(x, y, 10, 20));
  }
  return rects as unknown as DOMRectList;
}

describe("RichTextarea painting", () => {
  beforeEach(() => {
    vi.spyOn(Range.prototype, "getClientRects").mockImplementation(fixedPitchRects);
  });
  afterEach(() => vi.restoreAllMocks());

  const pieces = (container: HTMLElement) =>
    [...container.querySelectorAll<HTMLElement>(".rt-piece")].map((n) => ({
      text: n.textContent,
      cls: [...n.classList].filter((c) => c !== "rt-piece").join(" "),
      at: [n.style.left, n.style.top].join(","),
    }));

  it("draws each styled run where the text put it, markers upright", () => {
    const { container } = render(<Field initial="a **b** *it*" onValue={() => {}} />);
    const drawn = pieces(container);
    expect(drawn).toContainEqual({ text: "b", cls: "rt-bold", at: "40px,0px" });
    expect(drawn).toContainEqual({ text: "it", cls: "rt-italic", at: "10px,20px" });
    expect(drawn.find((p) => p.at === "0px,20px")).toMatchObject({ text: "*" });
    expect(drawn.find((p) => p.text === "it")!.cls).not.toContain("muted");
  });

  it("splits a run at each line it wraps across", () => {
    const { container } = render(<Field initial="abcdefghijklmnopqrst" onValue={() => {}} />);
    expect(pieces(container)).toEqual([
      { text: "abcdefgh", cls: "", at: "0px,0px" },
      { text: "ijklmnop", cls: "", at: "0px,20px" },
      { text: "qrst", cls: "", at: "0px,40px" },
    ]);
  });

  it("keeps a wrapped line on its own line when its first glyph also reports the line before", () => {
    // iOS WebKit: a range starting a soft-wrapped line also yields a zero-width box at the previous line's end.
    vi.spyOn(Range.prototype, "getClientRects").mockImplementation(function (this: Range) {
      const rects = [...fixedPitchRects.call(this)];
      const piece = this.startContainer.parentElement?.closest(".rt-piece");
      const i = this.startOffset;
      if (!piece && i > 0 && i % 8 === 0) rects.unshift(new DOMRect(80, (i / 8 - 1) * 20, 0, 20));
      return rects as unknown as DOMRectList;
    });
    const { container } = render(<Field initial="abcdefghijklmnopqrst" onValue={() => {}} />);
    expect(pieces(container).map((p) => p.at)).toEqual(["0px,0px", "0px,20px", "0px,40px"]);
  });
});
