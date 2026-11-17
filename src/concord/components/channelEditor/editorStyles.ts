import { cn } from "@/lib/utils";

// The touch menu sheet's rows (`menu-sheet.tsx`), so the editor reads as one of them.
export const SHEET_ROW =
  "flex min-h-11 w-full items-center gap-3 clip-corner px-3 py-2.5 text-left text-chat font-medium active:bg-secondary disabled:opacity-50";
export const SHEET_TILE = "flex size-10 shrink-0 items-center justify-center clip-corner-lg bg-secondary";
export const SHEET_TITLE = "truncate text-base font-semibold leading-tight tracking-normal";
export const SHEET_BACK =
  "-m-0.5 flex size-11 shrink-0 items-center justify-center clip-corner-lg text-muted-foreground active:bg-secondary";
export const SHEET_DIVIDER = "mx-3 my-1.5 h-px bg-foreground/10";

export const GROUP_LABEL = "text-xs font-medium uppercase tracking-wide text-muted-foreground";

/** The surface a borderless field sinks into, by what it sits on. */
export type Surface = "background" | "chrome";
const WELL: Record<Surface, string> = { background: "bg-chrome", chrome: "bg-background/40" };
export const well = (surface: Surface) => WELL[surface];
export const field = (surface: Surface) => cn("border-transparent", WELL[surface]);
