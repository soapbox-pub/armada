import { defineMessages } from "@/i18n/intl";

/** What the sheet and the pane both say. */
export const editorMessages = defineMessages({
  general: { id: "channelEditor.tab.general", defaultMessage: "General" },
  permissions: { id: "channelEditor.tab.permissions", defaultMessage: "Permissions" },
  category: { id: "channelEditor.category", defaultMessage: "Category" },
  noCategory: { id: "channelEditor.noCategory", defaultMessage: "No category" },
  targets: { id: "channelEditor.targets", defaultMessage: "Roles and members" },
  addTarget: { id: "channelEditor.addTarget", defaultMessage: "Add role or member" },
  removeTarget: {
    id: "channelEditor.removeTarget",
    defaultMessage: "{scope, select, category {Remove from category} other {Remove from channel}}",
  },
  ruleContext: { id: "channelEditor.ruleContext", defaultMessage: "{scope, select, category {in {name}} other {in #{name}}}" },
  sync: { id: "channelEditor.sync", defaultMessage: "Use {category}'s permissions" },
  syncHint: { id: "channelEditor.syncHint", defaultMessage: "Stay in step with the category." },
  syncedNote: {
    id: "channelEditor.syncedNote",
    defaultMessage: "Roles and members are set on {category}. This channel's own rules are kept, and apply again if you switch this off.",
  },
  syncRefused: { id: "channelEditor.syncRefused", defaultMessage: "Syncing swaps permissions you can't set; ask someone who can." },
  unkeyed: { id: "channelEditor.unkeyed", defaultMessage: "You can only change who reads a private channel you can read." },
  private: { id: "channelEditor.private", defaultMessage: "Private channel" },
  privateHint: { id: "channelEditor.privateHint", defaultMessage: "Its own key, for only those allowed to view it." },
  rotate: { id: "channelEditor.rotate", defaultMessage: "Rotate key" },
  rotateHint: { id: "channelEditor.rotateHint", defaultMessage: "A fresh key for exactly who is let in today." },
  syncAll: { id: "channelEditor.syncAll", defaultMessage: "Sync all channels" },
  syncAllHint: {
    id: "channelEditor.syncAllHint",
    defaultMessage: "{count, plural, one {# channel uses its own permissions.} other {# channels use their own permissions.}}",
  },
  deleteChannel: { id: "channelEditor.deleteChannel", defaultMessage: "Delete channel" },
  deleteCategory: { id: "channelEditor.deleteCategory", defaultMessage: "Delete category" },
  channelSub: {
    id: "channelEditor.channelSub",
    defaultMessage:
      "{kind, select, privateIn {Private channel in {category}} private {Private channel} publicIn {Channel in {category}} other {Channel}}",
  },
  categorySub: {
    id: "channelEditor.categorySub",
    defaultMessage: "{count, plural, =0 {Category with no channels} one {Category with # channel} other {Category with # channels}}",
  },
  missing: { id: "channelEditor.missing", defaultMessage: "{scope, select, category {This category is gone.} other {This channel is gone.}}" },
});
