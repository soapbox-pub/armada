import { type SlashCommand } from "@/lib/slashCommands";

/**
 * Slash commands that make sense on the Bluetooth mesh. The mesh has no
 * moderation, no relays and no threads, so the Nostr-only commands
 * (`/kick`, `/ban`, `/poll`, `/thread`) are excluded. What's left is pure text
 * rewrites plus `/mention`, which just opens the `@` picker.
 *
 * Execution itself is the shared `executeSlashCommand` runner in
 * `slashCommands.ts` — this module only declares which commands the mesh
 * surface exposes (used both as the menu `commandFilter` and the runner's
 * `isAllowed` gate, so typed and picked commands agree).
 */
export const MESH_SLASH_NAMES = new Set(["me", "shrug", "tableflip", "unflip", "slap", "mention", "location"]);

/** A mesh command is one of the allowed set (by primary name). */
export function isMeshSlashCommand(command: SlashCommand): boolean {
  return MESH_SLASH_NAMES.has(command.name);
}
