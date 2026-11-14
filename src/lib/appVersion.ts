import { getLocale } from "@/i18n";

/** "v1.2.3 (commit, date)", with a `+` on builds made between release tags. */
export function appVersionLabel(): string {
  const date = new Date(import.meta.env.BUILD_DATE).toLocaleDateString(getLocale());
  const detail = [import.meta.env.COMMIT_SHA, date].filter(Boolean).join(", ");
  return `v${import.meta.env.VERSION}${import.meta.env.COMMIT_TAG ? "" : "+"} (${detail})`;
}
