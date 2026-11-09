import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { invalidateOnce } from "@/lib/invalidateOnce";

describe("invalidateOnce", () => {
  it("invalidates a key once per synchronous run, and again in the next", async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue();
    for (let i = 0; i < 7; i++) invalidateOnce(client, ["dm17", "conversations", "me"]);
    invalidateOnce(client, ["dm17", "conversations", "other"]);
    expect(invalidate).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    invalidateOnce(client, ["dm17", "conversations", "me"]);
    expect(invalidate).toHaveBeenCalledTimes(3);
  });
});
