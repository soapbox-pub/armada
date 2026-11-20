import { act, render } from "@testing-library/react";
import { useCallback } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: { pubkey: "a".repeat(64) } }) }));
vi.mock("@/hooks/useAppContext", () => ({ useAppContext: () => ({ config: { automaticSettingsSync: false } }) }));
vi.mock("@/hooks/useSettingsDoc", () => ({
  useSettingsDoc: () => ({ doc: undefined, sources: [], isFetched: true, update: vi.fn(), hasNip44Support: false }),
}));
vi.mock("@/hooks/useEncryptedSettings", () => ({ useEncryptedSettings: () => ({ doc: undefined }) }));

import { ReadStateProvider } from "@/components/ReadStateProvider";
import { useReadStateActions, useReadStateSelect } from "@/hooks/useReadState";

import type { ReadStateMap } from "@/contexts/ReadStateContext";

describe("the read-state store", () => {
  it("re-renders a reader only when its own stamp moves, and reads the latest state", () => {
    let renders = 0;
    let actions: ReturnType<typeof useReadStateActions> | undefined;
    function Reader() {
      renders++;
      actions = useReadStateActions();
      const stamp = useReadStateSelect(useCallback((map: ReadStateMap) => map.mine ?? 0, []));
      return <span data-testid="stamp">{stamp}</span>;
    }
    const { getByTestId } = render(
      <ReadStateProvider>
        <Reader />
      </ReadStateProvider>,
    );
    const before = renders;
    act(() => actions!.markRead("other", 100));
    expect(renders).toBe(before);
    expect(actions!.getLastRead("other")).toBe(100);
    act(() => actions!.markRead("mine", 200));
    expect(renders).toBe(before + 1);
    expect(getByTestId("stamp").textContent).toBe("200");
  });
});
