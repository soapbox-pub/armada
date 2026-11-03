import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TermsGate } from "./TermsGate";
import { TERMS_ACCEPTED_KEY, termsNeeded } from "@/lib/platform";

let platform = "ios";
vi.mock("@capacitor/core", async (orig) => {
  const actual = await orig<typeof import("@capacitor/core")>();
  return { ...actual, Capacitor: { ...actual.Capacitor, getPlatform: () => platform } };
});

describe("TermsGate", () => {
  beforeEach(() => {
    platform = "ios";
    localStorage.removeItem(TERMS_ACCEPTED_KEY);
  });
  afterEach(() => localStorage.removeItem(TERMS_ACCEPTED_KEY));

  it("passes straight through off iOS", () => {
    platform = "web";
    expect(termsNeeded()).toBe(false);
    render(<TermsGate><p>login</p></TermsGate>);
    expect(screen.getByText("login")).toBeInTheDocument();
  });

  it("holds the children on iOS until the terms are ticked and accepted", () => {
    const onAccepted = vi.fn();
    render(<TermsGate onAccepted={onAccepted}><p>login</p></TermsGate>);
    expect(screen.queryByText("login")).not.toBeInTheDocument();

    const button = screen.getByRole("button", { name: "Continue" });
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(button).toBeEnabled();
    fireEvent.click(button);

    expect(screen.getByText("login")).toBeInTheDocument();
    expect(onAccepted).toHaveBeenCalledOnce();
    expect(termsNeeded()).toBe(false);
  });

  it("asks once per device", () => {
    localStorage.setItem(TERMS_ACCEPTED_KEY, "1");
    render(<TermsGate><p>login</p></TermsGate>);
    expect(screen.getByText("login")).toBeInTheDocument();
  });
});
