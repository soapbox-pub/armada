import { defineMessages } from "@/i18n/intl";

/** What a reviewed change says before, while and after it is applied. */
export const reviewMessages = defineMessages({
  title: { id: "accessReview.title", defaultMessage: "Review changes" },
  heading: { id: "accessReview.heading", defaultMessage: "Apply changes?" },
  applyingTitle: { id: "accessReview.applyingTitle", defaultMessage: "Applying changes" },
  unfinishedTitle: { id: "accessReview.unfinishedTitle", defaultMessage: "Not finished" },
  apply: { id: "accessReview.apply", defaultMessage: "Apply changes" },
  applying: { id: "accessReview.applying", defaultMessage: "Applying" },
  applyUnfinished: { id: "accessReview.applyUnfinished", defaultMessage: "The changes didn't finish applying" },

  loses: { id: "accessReview.loses", defaultMessage: "Loses access · {count}" },
  gains: { id: "accessReview.gains", defaultMessage: "Gains access · {count}" },
  keeps: { id: "accessReview.keeps", defaultMessage: "Keeps access · {count}" },
  gainsPermissions: { id: "accessReview.gainsPermissions", defaultMessage: "Gains permissions" },
  losesPermissions: { id: "accessReview.losesPermissions", defaultMessage: "Loses permissions" },
  more: { id: "accessReview.more", defaultMessage: "{count} more" },
  others: { id: "accessReview.others", defaultMessage: "{count, plural, one {# other} other {# others}}" },

  roadRole: { id: "accessReview.road.role", defaultMessage: "Through {role}" },
  roadRoleLost: { id: "accessReview.road.roleLost", defaultMessage: "Had it through {role}" },
  roadMember: { id: "accessReview.road.member", defaultMessage: "Added by name" },
  roadMemberLost: { id: "accessReview.road.memberLost", defaultMessage: "Was added by name" },
  roadEveryone: { id: "accessReview.road.everyone", defaultMessage: "Open to everyone" },
  roadEveryoneLost: { id: "accessReview.road.everyoneLost", defaultMessage: "Was open to everyone" },
  roadCreator: { id: "accessReview.road.creator", defaultMessage: "Created the channel" },

  loseKeyed: {
    id: "accessReview.tldr.loseKeyed",
    defaultMessage:
      "{count, plural, one {{names} stops getting {where} from here on, and keeps what they've already read.} other {{names} stop getting {where} from here on, and keep what they've already read.}}",
  },
  loseHidden: {
    id: "accessReview.tldr.loseHidden",
    defaultMessage:
      "{count, plural, one {{names} will no longer see {where}. It isn't private, so this hides it rather than locking it.} other {{names} will no longer see {where}. It isn't private, so this hides it rather than locking it.}}",
  },
  gainKeyed: {
    id: "accessReview.tldr.gainKeyed",
    defaultMessage: "{count, plural, one {{names} is sent the key to {where}.} other {{names} are sent the key to {where}.}}",
  },
  gainFresh: {
    id: "accessReview.tldr.gainFresh",
    defaultMessage:
      "{count, plural, one {{names} joins {where} on a new key, and can't read what came before.} other {{names} join {where} on a new key, and can't read what came before.}}",
  },
  gainShown: {
    id: "accessReview.tldr.gainShown",
    defaultMessage: "{count, plural, one {{names} will see {where}.} other {{names} will see {where}.}}",
  },
  goesPrivate: {
    id: "accessReview.tldr.private",
    defaultMessage:
      "{where} gets its own key from here on, and its permissions decide who may read it. Messages already posted stay readable to everyone in the community; a restriction can't be applied backwards.",
  },
  goesPublic: {
    id: "accessReview.tldr.public",
    defaultMessage:
      "Every member can read what's said in {where} from now on. What was said while it was private stays readable only to those who held its key.",
  },
  keepOpen: { id: "accessReview.keepOpen", defaultMessage: "<b>Keep Armada open</b> until it's done." },
  keepOpenWorking: {
    id: "accessReview.keepOpenWorking",
    defaultMessage: "<b>Keep Armada open</b> and your signer within reach until this finishes.",
  },
  ifStopped: {
    id: "accessReview.ifStopped",
    defaultMessage:
      "{count, plural, one {If it stops early, {names} can still read {where}.} other {If it stops early, {names} can still read {where}.}}",
  },
  stuck: {
    id: "accessReview.stuck",
    defaultMessage:
      "This is taking longer than expected. Your signer may be slow or offline. You can close this; anything already sent will finish on its own.",
  },

  stepSave: { id: "accessReview.step.save", defaultMessage: "Saving the changes" },
  stepPrivate: { id: "accessReview.step.private", defaultMessage: "Making the channel private" },
  stepRotate: {
    id: "accessReview.step.rotate",
    defaultMessage: "{count, plural, one {Rotating the channel key} other {Rotating # channel keys}}",
  },
  stepSend: {
    id: "accessReview.step.send",
    defaultMessage: "{count, plural, one {Sending the key to # member} other {Sending the key to # members}}",
  },
  sealing: { id: "accessReview.sealing", defaultMessage: "Sealing the key for each member. Your signer may ask for each one." },

  stopped: {
    id: "accessReview.unfinished.stopped",
    defaultMessage: "It stopped before finishing. Nothing after the failed step was written.",
  },
  stillReads: {
    id: "accessReview.unfinished.rotate",
    defaultMessage:
      "{count, plural, one {<b>{names} can still read {where}.</b> The change is saved, but the key wasn't rotated.} other {<b>{names} can still read {where}.</b> The change is saved, but the key wasn't rotated.}}",
  },
  rotateUnheld: {
    id: "accessReview.unfinished.rotateUnheld",
    defaultMessage: "You don't hold that key, so a member who does has to rotate it.",
  },
  rotateNotAllowed: {
    id: "accessReview.unfinished.rotateNotAllowed",
    defaultMessage: "Rotating it needs the Manage channels permission. Ask an admin to rotate it.",
  },
  notSent: {
    id: "accessReview.unfinished.send",
    defaultMessage: "The change is saved, but the key hasn't reached everyone let in yet. Armada keeps trying while it's open.",
  },
  sendUnheld: {
    id: "accessReview.unfinished.sendUnheld",
    defaultMessage: "You don't hold the key to {where}, so a member who does has to share it.",
  },
  keysNotMoved: {
    id: "accessReview.unfinished.keys",
    defaultMessage: "The change is saved, but its keys weren't all moved. Armada keeps trying while it's open.",
  },
});
