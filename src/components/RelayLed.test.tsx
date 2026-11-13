import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { blinkSeconds, SLOW_MS, StatusLed } from "./RelayLed";

describe("StatusLed", () => {
  it("names each state, with the response time once there is one", () => {
    const { rerender } = render(<StatusLed alive={undefined} noun="relay" />);
    expect(screen.getByRole("img")).toHaveAccessibleName("Checking relay");

    rerender(<StatusLed alive ms={142} noun="relay" />);
    expect(screen.getByRole("img")).toHaveAccessibleName("Relay reachable (142 ms)");

    rerender(<StatusLed alive ms={SLOW_MS} noun="server" />);
    expect(screen.getByRole("img")).toHaveAccessibleName(`Server slow to answer (${SLOW_MS.toLocaleString("en")} ms)`);

    rerender(<StatusLed alive={false} ms={90} noun="relay" />);
    expect(screen.getByRole("img")).toHaveAccessibleName("Relay unreachable");
  });

  it("blinks faster the quicker the answer, within bounds", () => {
    expect(blinkSeconds(0)).toBe(0.8);
    expect(blinkSeconds(250)).toBeCloseTo(1.2);
    expect(blinkSeconds(1000)).toBeCloseTo(2.4);
    expect(blinkSeconds(60_000)).toBe(4);
    expect(blinkSeconds(undefined)).toBe(2);
  });

  it("sets a live light's period from its response time, offsetting only a phased one", () => {
    const { container, rerender } = render(<StatusLed alive ms={250} noun="relay" />);
    const led = container.firstElementChild as HTMLElement;
    expect(led.style.animationDuration).toBe("1.20s");
    expect(led.style.animationDelay).toBe("");

    rerender(<StatusLed alive ms={250} phase={2} noun="relay" />);
    expect(led.style.animationDelay).toBe("0.58s");

    rerender(<StatusLed alive={false} ms={250} noun="relay" />);
    expect(led.style.animationDuration).toBe("");
  });

  it("hides a legend light from assistive tech", () => {
    const { container } = render(<StatusLed alive noun="relay" decorative />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
  });
});
