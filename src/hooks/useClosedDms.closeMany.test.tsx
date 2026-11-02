import { act, renderHook } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { AppContext, defaultConfig, type AppConfig } from "@/contexts/AppContext";
import { useClosedDms } from "@/hooks/useClosedDms";

function setup(initial: Partial<AppConfig>) {
  let config: AppConfig = { ...defaultConfig, ...initial };
  let writes = 0;
  function Wrapper({ children }: { children: ReactNode }) {
    const [value, setValue] = useState(config);
    const updateConfig = (updater: (current: AppConfig) => AppConfig) => {
      writes++;
      setValue((current) => (config = updater(current)));
    };
    return <AppContext.Provider value={{ config: value, updateConfig }}>{children}</AppContext.Provider>;
  }
  const hook = renderHook(() => useClosedDms(), { wrapper: Wrapper });
  return { hook, get config() { return config; }, get writes() { return writes; } };
}

describe("useClosedDms.closeMany", () => {
  it("closes every row in one config write and unpins them", () => {
    const t = setup({ pinnedDms: ["a", "keep"] });
    act(() => {
      t.hook.result.current.closeMany([
        { peer: "a", latest: { id: "x", created_at: 10 } },
        { peer: "b", latest: { id: "y", created_at: 20 } },
      ]);
    });
    expect(t.writes).toBe(1);
    expect(t.config.closedDms).toEqual({
      a: { eventId: "x", createdAt: 10 },
      b: { eventId: "y", createdAt: 20 },
    });
    expect(t.config.pinnedDms).toEqual(["keep"]);
    expect(t.hook.result.current.isClosed("a", { id: "x", created_at: 10 })).toBe(true);
    expect(t.hook.result.current.isClosed("b", { id: "z", created_at: 21 })).toBe(false);
  });

  it("writes nothing for an empty batch", () => {
    const t = setup({});
    act(() => t.hook.result.current.closeMany([]));
    expect(t.writes).toBe(0);
  });
});
