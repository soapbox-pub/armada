import { createContext, useContext } from "react";

/** A touch menu sheet's state, as the rows inside it see it. */
export interface MenuSheetApi {
  close: () => void;
  /** Open nested pages, outermost first; the last one is showing. */
  pages: readonly string[];
  openPage: (id: string) => void;
  back: () => void;
  /** Where a nested page renders: beside the root list, which is hidden under it. */
  outlet: HTMLElement | null;
}

export const MenuSheetContext = createContext<MenuSheetApi | null>(null);

/** The enclosing touch menu sheet, or null inside a popup menu. */
export const useMenuSheet = () => useContext(MenuSheetContext);

export const ContextMenuOpenContext = createContext<(() => void) | null>(null);

/** Opens the enclosing ContextMenu, so a touch "more" button shows the sheet a hold does. */
export const useOpenContextMenu = () => useContext(ContextMenuOpenContext);

const openSheets = new Set<() => void>();

export function trackOpenMenuSheet(close: () => void): () => void {
  openSheets.add(close);
  return () => {
    openSheets.delete(close);
  };
}

/** Closes the open menu sheet from outside React: a hold that turned into a drag. */
export function closeOpenMenuSheets(): void {
  for (const close of [...openSheets]) close();
}
