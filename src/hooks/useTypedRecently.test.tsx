import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { STRAY_PRESS_MS, useTypedRecently } from "@/hooks/useTypedRecently";

/** A composer and a call button guarded the way the DM header's is. */
function Harness({ onCall }: { onCall: () => void }) {
  const typedRecently = useTypedRecently();
  return (
    <div>
      <textarea aria-label="composer" onKeyDown={(e) => e.stopPropagation()} />
      <div aria-label="editor" contentEditable suppressContentEditableWarning />
      <button type="button" onClick={() => !typedRecently() && onCall()}>
        call
      </button>
    </div>
  );
}

function setup() {
  const onCall = vi.fn();
  const view = render(<Harness onCall={onCall} />);
  return {
    onCall,
    composer: view.getByLabelText("composer"),
    editor: view.getByLabelText("editor"),
    button: view.getByRole("button", { name: "call" }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useTypedRecently", () => {
  it("lets a click through when nothing was typed", () => {
    const { onCall, button } = setup();
    fireEvent.click(button);
    expect(onCall).toHaveBeenCalledTimes(1);
  });

  it("drops a click landing mid-sentence (a palm on the touchpad)", () => {
    const { onCall, composer, button } = setup();
    fireEvent.keyDown(composer, { key: "h" });
    vi.advanceTimersByTime(300);
    fireEvent.click(button);
    expect(onCall).not.toHaveBeenCalled();
  });

  it("drops Space on a focused button while the user is typing", () => {
    const { onCall, composer, button } = setup();
    fireEvent.keyDown(composer, { key: "o" });
    button.focus();
    // A button's keyboard activation reaches React as a click.
    fireEvent.keyDown(button, { key: " " });
    fireEvent.click(button);
    expect(onCall).not.toHaveBeenCalled();
  });

  it("lets a click through once typing has paused", () => {
    const { onCall, composer, button } = setup();
    fireEvent.keyDown(composer, { key: "h" });
    vi.advanceTimersByTime(STRAY_PRESS_MS);
    fireEvent.click(button);
    expect(onCall).toHaveBeenCalledTimes(1);
  });

  it("sees keystrokes a field stops from propagating", () => {
    const { onCall, composer, button } = setup();
    // The harness's composer stops propagation, as the real composer's handlers can.
    fireEvent.keyDown(composer, { key: "x" });
    fireEvent.click(button);
    expect(onCall).not.toHaveBeenCalled();
  });

  it("counts typing into a contenteditable", () => {
    const { onCall, editor, button } = setup();
    fireEvent.keyDown(editor, { key: "x" });
    fireEvent.click(button);
    expect(onCall).not.toHaveBeenCalled();
  });

  it("treats Tab as deliberate: a button tabbed to can be pressed at once", () => {
    const { onCall, composer, button } = setup();
    fireEvent.keyDown(composer, { key: "h" });
    fireEvent.keyDown(composer, { key: "Tab", shiftKey: true });
    button.focus();
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.click(button);
    expect(onCall).toHaveBeenCalledTimes(1);
  });

  it("ignores keys pressed outside a text field", () => {
    const { onCall, button } = setup();
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    document.body.append(checkbox);
    fireEvent.keyDown(checkbox, { key: " " });
    checkbox.remove();
    fireEvent.keyDown(document.body, { key: "ArrowDown" });
    fireEvent.click(button);
    expect(onCall).toHaveBeenCalledTimes(1);
  });

  it("stops listening and forgets the last keystroke once nothing uses it", () => {
    const first = setup();
    fireEvent.keyDown(first.composer, { key: "h" });
    cleanup();
    const second = setup();
    fireEvent.click(second.button);
    expect(second.onCall).toHaveBeenCalledTimes(1);
  });
});
