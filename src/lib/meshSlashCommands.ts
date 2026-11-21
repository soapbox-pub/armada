import { type SlashCommand } from "@/lib/slashCommands";

/**
 * Slash commands exposed on the Bluetooth mesh (no moderation/relays/threads, so
 * no `/kick`, `/ban`, `/poll`, `/thread`). Used as both menu filter and runner gate.
 */
export const MESH_SLASH_NAMES = new Set(["me", "shrug", "tableflip", "unflip", "slap", "roll", "mention"]);

export function isMeshSlashCommand(command: SlashCommand): boolean {
  return MESH_SLASH_NAMES.has(command.name);
}
