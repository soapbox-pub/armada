import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RefoundProgressLine } from "./RefoundProgressLine";

describe("RefoundProgressLine", () => {
  it("names the step and which one of how many, with a bar that fills", () => {
    render(<RefoundProgressLine progress={{ step: "encrypting", done: 3, total: 10 }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Sealing the new key for each member (4 of 10)");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "30");
  });

  it("sweeps for a step with no count, and starts at reading", () => {
    const { rerender } = render(<RefoundProgressLine progress={null} />);
    expect(screen.getByRole("status")).toHaveTextContent("Reading the community's current state");
    rerender(<RefoundProgressLine progress={{ step: "links" }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Updating your invite links");
    expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
  });
});
