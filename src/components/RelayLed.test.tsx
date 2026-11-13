import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SLOW_MS, StatusLed } from "./RelayLed";

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

  it("blinks every live light at one rate, offsetting only a phased one", () => {
    const { container, rerender } = render(<StatusLed alive ms={50} noun="relay" />);
    const led = container.firstElementChild as HTMLElement;
    expect(led.className).toContain("armada-led-up_2s");
    expect(led.style.animationDuration).toBe("");
    expect(led.style.animationDelay).toBe("");

    rerender(<StatusLed alive ms={50} phase={2} noun="relay" />);
    expect(led.style.animationDelay).toBe("0.58s");
  });

  it("hides a legend light from assistive tech", () => {
    const { container } = render(<StatusLed alive noun="relay" decorative />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
  });
});
