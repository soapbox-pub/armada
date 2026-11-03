import { createContext } from "react";

/** A Settings screen. The root list is not one: it is the empty stack. */
export type SettingsPageId =
  | "profile"
  | "ultra"
  | "account"
  | "notifications"
  | "privacy"
  | "blocked"
  | "muted-words"
  | "appearance"
  | "chat"
  | "dms"
  | "voice"
  | "emojis"
  | "relays"
  | "wallet"
  | "storage"
  | "desktop"
  | "diagnostics"
  | "support"
  | "about";

/** Pages reached from inside another page rather than from the root list. */
export const SETTINGS_PAGE_PARENT: Partial<Record<SettingsPageId, SettingsPageId>> = {
  blocked: "privacy",
  "muted-words": "privacy",
};

/**
 * Section ids links carry (`/settings#<id>`, `SettingsOverlay.show(id)`) that
 * name a group on a page rather than a page, including ones from before
 * Settings had pages.
 */
const SECTION_PAGE: Record<string, SettingsPageId> = {
  keys: "account",
  sync: "account",
  standing: "account",
  danger: "account",
  muted: "blocked",
  media: "privacy",
  links: "privacy",
  discover: "privacy",
  "app-relays": "relays",
  uploads: "relays",
};

const PAGE_IDS = new Set<string>([
  "profile", "ultra", "account", "notifications", "privacy", "blocked", "muted-words", "appearance", "chat",
  "dms", "voice", "emojis", "relays", "wallet", "storage", "desktop", "diagnostics", "support", "about",
] satisfies SettingsPageId[]);

function isPageId(id: string): id is SettingsPageId {
  return PAGE_IDS.has(id);
}

/** The page stack a section link opens, and the group to scroll to; null for the root list. */
export function resolveSettingsSection(section: string): { stack: SettingsPageId[]; anchor?: string } | null {
  const page = SECTION_PAGE[section] ?? (isPageId(section) ? section : undefined);
  if (!page) return null;
  const parent = SETTINGS_PAGE_PARENT[page];
  return {
    stack: parent ? [parent, page] : [page],
    anchor: page === section ? undefined : section,
  };
}

export interface SettingsNav {
  /** Push a page over the current one. */
  open: (id: SettingsPageId) => void;
}

export const SettingsNavContext = createContext<SettingsNav>({ open: () => {} });

/** True while settings search lists every page at once, so collapsed rows mount open to be matched. */
export const SettingsSearchingContext = createContext(false);

/** The page a group sits on, so settings search can match a group by its page's name. */
export const SettingsPageTitleContext = createContext("");
