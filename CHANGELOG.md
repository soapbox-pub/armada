# Changelog

All notable changes to Armada are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and releases are tagged
`vX.Y.Z`.

## [0.67.3] - 2026-11-02

A new Reduce effects setting calms animations, animated images, blur and
flair, and the desktop app uses less memory and CPU: it rests while hidden,
offers a Low memory mode, and decodes avatars and emoji at the size they're
shown. This release also tightens privacy and security around images, Mini Apps
and the desktop shell.

### Added
- A Reduce effects setting that stops animations, pauses animated images, reduces blur and hides Ultra flair, each part adjustable on its own
- A desktop Low memory mode, applied from the next launch with a restart button
- People without a name or picture get a hat-and-glasses avatar

### Changed
- The desktop app rests while hidden or minimized, pausing background sync rounds and animations while staying connected for new messages
- Avatars, custom emoji and community banners are shown downscaled to their size, using less memory, including animated ones
- The desktop app starts and reloads faster and uses less memory
- The composer opens faster, loading emoji data only once you type a shortcode
- Background history sync for communities is gentler on battery and bandwidth
- Ultra names in lists stop shimmering after a couple of cycles

### Fixed
- Photos from cameras that don't label their file type have their location and camera details removed
- Location and camera details are removed from animated images and more image formats
- Removing a message from this device also removes the author's edits of it
- Images that fail to load on the desktop app because of the host's settings now display
- Mini App icons, profile field media, relay icons and banners and watch-along thumbnails respect your media proxy setting
- More local network addresses are recognized and never loaded from messages
- Logging out clears more locally stored message data
- Tighter security checks for messages, Mini Apps, notifications and the desktop app

## [0.67.2] - 2026-11-01

You can now remove a reported message from your device entirely, resize the
channel and member lists on desktop, and jump straight to your first unread
message. Odysee and PeerTube videos play inline, magnet links open in your
torrent app, and themes can use your own font. Plus a long list of fixes for
notifications, sync and message display.

### Added
- Remove a reported message from this device, including every decrypted copy and its media
- Resize the channel and member lists on desktop by dragging their edge
- A Jump to unread button while the new-messages divider is out of view
- Odysee and PeerTube videos play inline in messages
- Magnet links in messages open in your torrent app
- Themes can use an uploaded font file
- Three or more muted channels fold into a collapsed Muted group at the end of the channel list
- Sort the Members page by name
- Hover over a message's time to see the full date and time
- A download button on the web page when JavaScript is turned off

### Changed
- The member sidebar is sorted by name, with nameless members last
- A stranger's invite artwork stays hidden in the invite inbox until you ask to see it
- YouTube links with a start time start playing there
- Desktop updates are offered in an in-app notice instead of a pop-up dialog
- Jumping to a replied-to message highlights it more clearly and keeps it centered while the messages around it load
- The desktop spellchecker downloads its dictionaries from armada.buzz instead of Google
- History sync holds back on metered connections on Android
- Blocked communities are kept out of background sync, calls, invites, Discover and link previews
- Thread replies in relay-hosted servers stay out of the main timeline

### Fixed
- Images the browser can't display are sent as files, with their location and camera details removed
- Saving your profile keeps its custom emoji
- Deleting a community message also removes its media from your device
- The message toolbar no longer covers the message above it
- Inline images without a known size take their real shape once loaded
- A custom theme's name font applies to author names
- Search closes when you switch channels
- Web notifications for a room close once you've read it, and encrypted messages the background can't open are shown by an open Armada tab
- Channels whose history the relay cut off no longer look complete, and communities with some invalid admin changes no longer stop loading

## [0.67.1] - 2026-10-30

You can now add your pronouns to your profile. They show under your name on
your profile page and in the profile card, and pronouns set in other Nostr apps
like Amethyst and Nos show up too.

### Added
- Pronouns on your profile, set in Settings › Profile and shown on profile pages and profile cards

## [0.67.0] - 2026-10-30

Introducing Armada Ultra, the premium tier that costs nothing. Turn it on in
Settings to get an Ultra badge next to your name, a shimmering name style, a
glowing avatar frame, a profile effect and exclusive themes, all visible to
everyone on Armada. Profile pictures and banners also open full size now.

### Added
- Armada Ultra in Settings: a free "subscription" with confetti and fanfare that adds an Ultra badge, name styles, avatar frames and profile effects everyone can see, plus Ultra-only themes
- Tap a profile picture or banner to view it full size

### Fixed
- Message notifications show the names of mentioned people instead of raw codes, even when this device hasn't seen them before
- Background notifications work when Armada runs as an nsite in Tenna

## [0.66.8] - 2026-10-25

Community invites from people you don't know now wait in a separate Requests
section, and the theme picker has been redesigned around your own themes.
Jumping to an old message opens the conversation right there, and search
results go past the first 100.

### Added
- Community invites from unknown senders are sorted into a collapsed Requests section, with a warning when opened; they no longer raise notifications or count as unread, and invites from muted people are hidden
- "Show more results" in community search, past the first 100 matches
- Git repository announcements show as a card with the clone address and a GitWorkshop link
- Press and hold a community in the sidebar on a touchscreen to open its menu, or keep moving your finger to drag it into a new position

### Changed
- The theme picker lists your own themes first with a New theme tile, merges the presets with System, Light and Dark, previews each theme's background and font, and credits each theme's creator
- Theme fonts apply across the whole app
- Jumping to an old message in a community opens the history around it, and you can scroll up or down from there
- Banning someone without resetting the community's keys also replaces the keys of the private channels they could read
- Uploads finish sooner when the preferred media server is slow but another already has the file

### Fixed
- Swiping back from the message list on a phone drags in the conversation you came from instead of an empty pane

## [0.66.7] - 2026-10-21

Formatted text in the message box now stays lined up with what you type on
Android with a larger system font size, and while the window is being resized.

### Fixed
- Formatted text in the message box no longer drifts from the typed text on Android when the system font size is enlarged
- Formatted text in the message box keeps up with the typed text while the window is resized

## [0.66.6] - 2026-10-20

Community calls can now be recorded, with every participant told and anyone
able to opt out, and Armada is available in Brazilian Portuguese. A blocked
community's page now ends in a Game Over screen with its own music.

### Added
- Record community calls, one file per person or a single mix, in FLAC, WAV, Opus or AU; everyone in the call sees who is recording, and anyone can choose "Don't record me"
- Brazilian Portuguese translation

### Changed
- A blocked community's page plays a chiptune theme and ends on a pixel-art Game Over screen, with Continue (the self-hosting guide) and Quit

### Fixed
- Formatted text in the message box lines up with the text being typed
- Opening the app no longer lands on a blocked community
- Remote-signer requests no longer send a duplicate copy just before timing out

## [0.66.5] - 2026-10-20

A blocked community's page now fills the whole pane, and bundled dependencies
are updated with security fixes.

### Fixed
- A blocked community's page fills the whole pane instead of a narrow column

### Changed
- Update bundled dependencies with security fixes

## [0.66.4] - 2026-10-20

Opening a community Armada has blocked, whether from the sidebar or an invite
link, now shows its ship struck down by a bolt from the heavens and blown to
pieces.

### Changed
- A blocked community's page and invite links show an animated scene of its ship struck by lightning and wrecked (the settled wreck when reduced motion is on)

## [0.66.3] - 2026-10-20

Communities that Armada has blocked for violating its content policy can no
longer be previewed, joined or opened, and they drop out of the sidebar and
notifications.

### Changed
- Communities blocked under Armada's content policy can't be opened or joined; their page explains they are unavailable, and they leave the sidebar, badges and notifications until the block is lifted

## [0.66.2] - 2026-10-20

Background notifications in the web app are turned off on iPhone, iPad and
Safari on macOS, which no longer show "Messages synced" alerts for pushes with
nothing new in them.

### Changed
- Background notifications are no longer offered in the web app on iPhone, iPad or Safari on macOS; Safari on macOS still shows notifications while Armada is open, and existing subscriptions on those browsers are removed

## [0.66.1] - 2026-10-20

Relay settings gain an optional proof-of-work setting for relays that ask
for it, and revoking a role that grants a private channel now locks its
former holders out of that channel.

### Added
- An optional proof-of-work difficulty in relay settings, off by default, for relays that require it to accept posts

### Fixed
- Revoking a role that grants access to a private channel now rotates the channel's key, so former holders can no longer read new messages

## [0.66.0] - 2026-10-19

Armada now speaks German, Spanish, French, Italian, Dutch and Japanese. The
composer shows mentions as names and styles markdown as you type, with a
formatting toolbar, and community search gains a date range and typed filters.
Channel and direct-message history fills in quietly in the background.

### Added
- The app is translated into German, Spanish, French, Italian, Dutch and Japanese, with dates and numbers in your region's format
- The composer shows mentions as names, custom emoji as images, and styles markdown live, with a formatting toolbar and shortcuts
- Community search has a date range and from:, in:, has:, before:, after: and during: filters with suggestions
- Channel and direct-message history backfills in the background, and search notes when history is still incomplete
- Toasts can be swiped away left, right or up

### Changed
- Character card fields render as markdown with a copy button each, and in-chat cards get a cleaner frame
- Mention and profile search ranks name matches ahead of address matches
- Links written as `<url>` show without the brackets or a preview card
- Android downloads are saved under Armada/ in Pictures, Movies, Music or Download
- An image dragged into the composer is uploaded rather than pasted as a link
- Each conversation keeps its own unsent draft
- Smoother channel scrolling, swiping and loading on mobile, and less slowdown in long timelines and the Discover page

### Fixed
- Cropped images and icon thumbnails keep their transparency
- A link inside a spoiler reveals the spoiler on first click instead of opening, and links end at spoiler bars
- Mentions keep working while you edit them before the name has loaded
- Android notifications start without waiting on a permission check, and a blocked notification channel is reported first
- Mention labels can no longer reorder surrounding text

## [0.65.0] - 2026-10-16

Settings is rebuilt as a native-style list of pages, signing up takes just a
profile step, and you can mute words across timelines and threads. Community
messages show Owner, Admin and Mod badges, character card images open into a
card viewer, and iOS notifications now show the message itself.

### Added
- A synced muted-words filter for timelines, threads and forum comments
- Owner, Admin and Mod badges beside staff names in community messages
- Character card images show the character's name and open a viewer with the card's details
- Highlights in embedded posts show their excerpt, comment and source
- A setting to hide the message hover actions on desktop, and the reaction row in the thread right-click menu
- The remote signer link can be copied from the login screen, and every sign-in method is offered on every platform
- A support page and a Help & support section in Settings

### Changed
- Settings is a drill-down list of pages, with long explanations behind info buttons
- Signing up no longer asks you to back up your key or pick relays; a reminder to back up your key appears later, and logging out asks first if it hasn't been backed up
- The terms notice appears under every sign-in method
- The downloads page is redesigned around a platform switcher, and downloads save under their real file names
- iOS notifications are decrypted on the device and show the message, with banners while the app is open unless you're in that room
- Android notifications cover DM relays more reliably, hold alerts while you're active on another device, and are throttled per conversation and community
- A call keeps floating while a community's settings or moderation pane is open
- Forum channels shown as a feed count only posts toward their unread badge

### Fixed
- Mentions from banned members no longer appear in Mentions, notifications or the server rail
- Clicking outside a profile preview only closes it, without also clicking what's underneath
- A channel key sent by staff no longer asks to be accepted manually while community permissions are still loading
- Linux package install commands on the downloads page point at the current repository addresses

## [0.64.14] - 2026-10-13

The downloads page and the desktop app's updater now read Armada's releases
in the same standard format app stores like Zapstore use, so every past
version, with all of its downloads, is listed in one place.

### Changed
- The downloads page and desktop updates read releases in the standard app-release format, and older versions load their downloads when expanded
- A new default profile picture, Cyber Oni by KrakenM, replaces the sloth

## [0.64.13] - 2026-10-12

Sent images now arrive with a preview that shows inline right away, and
animated GIFs stay animated when cropped. You can hide message previews in the
DM list, and Armada uses much less data and battery keeping communities,
messages and notifications in sync.

### Added
- Sent images include a preview that shows inline, with the full image loading in the lightbox
- A synced setting to hide message previews in the DM list
- Discord-style `-#` subtext lines in chat messages

### Changed
- Cropping an animated GIF keeps its animation
- Settings › Relays is laid out like the signup wizard, with sync in its own section
- Forum posts and comments no longer have a character limit
- Opening a community on mobile no longer jumps straight into a channel
- Images and share-shortcut avatars are cached on disk instead of being downloaded again
- Much less network traffic and battery use syncing communities, DMs and settings, and in the Android notification service
- Relays that never connect are retried less often, including across restarts

### Fixed
- The DM list no longer shows a deleted message as a conversation's latest
- Voice calls no longer fail to start where the microphone level can't be read

## [0.64.12] - 2026-10-10

Incoming calls on Android now ring instead of joining by themselves, with a
proper lock-screen ringer. You can copy highlighted text from the message menu,
and Armada uses less memory over long sessions and leaves less behind in memory
after you log out.

### Added
- Copy selection in the message right-click menu when text is highlighted
- Saving your profile adds image details to your picture and banner so other apps can show a preview while they load

### Changed
- Microphone auto gain control is off by default
- The profile preview card no longer has a Follow button

### Fixed
- Incoming calls on Android ring on a lock-screen ringer and join only when you tap Answer
- Lower memory use over long sessions, in the app and in the Android notification service
- Decrypted messages and community keys are cleared from memory on logout

## [0.64.11] - 2026-10-09

Private settings are harder to trace back to you. Your synced settings, GIF
favorites and conversation list are now stored under keys only your devices can
work out, with a single small record tied to your account. Settings from earlier
versions carry over on their own.

### Changed
- Synced settings, GIF favorites and the conversation list are stored under unlinkable keys, leaving one fixed-size record tied to your account
- Signer apps and bunkers are asked to approve settings sync once per device instead of on every change
- GIF favorites and the conversation list are shared across devices as one copy instead of one per device

## [0.64.10] - 2026-10-09

Pick your own quick reactions, and right-click a message to react straight
from the menu. Signup now ends with a step that sets up your relays, DM inbox
and media servers, and accounts without a DM inbox can add one in a tap.
Relay, DM and media server settings are each one tidy list.

### Added
- Pin your own quick reactions in Chat settings, with tap-to-swap and drag-to-reorder
- Quick reactions and an Add reaction button at the top of the message right-click menu
- A relay step at the end of signup that sets up your relays, DM inbox and media servers
- One-tap DM inbox setup in the DM list and Settings for accounts that have none
- A status light and site icon on each media server row

### Changed
- Relay, DM inbox and media server settings are each a single list, with broadcast, search and community relays under Relays → Advanced
- Key creation is folded into the save-your-key step of signup
- More default relays and media servers for new accounts
- The typing indicators setting moved to Chat settings and now applies to Concord and Buzz channels too
- The color picker lays out side by side on short screens
- A Concord invite link in the middle of a message shows its card after the text

### Fixed
- The message toolbar stays up while its emoji picker or menu is open
- X and Instagram embeds that never load fall back to a plain link
- On Android, Back returns to the chat behind the list instead of leaving the app when "Back leaves the app" is off
- On desktop, installing a web update mid-session no longer leaves the window on a "Not Found" page

## [0.64.9] - 2026-10-08

Link previews and site icons load again, and Armada no longer sends usage
analytics. The privacy policy now names the default servers Armada uses and
the error reporting on the hosted site.

### Changed
- The privacy policy names Armada's default servers and the hosted site's error reporting

### Fixed
- Link previews and site icons load again

### Removed
- Usage analytics

## [0.64.8] - 2026-10-07

Call audio devices stick: the chosen speaker is kept across calls and
reconnects, and mic or speaker picks in Settings switch a live call. Relay
lists show whether each relay is reachable, tapping a reply banner jumps to the
original message, and back/forward navigation and mobile spacing are tidier.

### Added
- A reachability light on relay rows, including community relay lists
- Tapping the reply banner in the composer jumps to the message being replied to

### Changed
- Mic and speaker picks in Settings → Voice apply to a call in progress
- Tighter, more even spacing for the mobile header and composer

### Fixed
- The chosen speaker is kept when joining or reconnecting to a call
- On Android, call audio follows the system's audio route instead of a remembered speaker
- The call bar shows Default as checked when the default output is playing
- No ringback plays when a call is answered while it is still being placed
- Back and forward onto a community channel show that channel's chat, and Android back from the first screen leaves the app
- Inviting someone directly no longer shows a stale success toast after the dialog closes, and reports failures
- The image viewer's page dots clear the screen edges and notch
- The avatar shape picker sizes correctly

## [0.64.7] - 2026-10-06

Armada's Zapstore listing now carries the desktop downloads for Linux, Windows
and macOS alongside the Android app.

### Changed
- Zapstore lists Armada's Linux, Windows and macOS downloads, not only Android

## [0.64.6] - 2026-10-06

Armada's Zapstore listing now carries the desktop downloads for Linux, Windows
and macOS alongside the Android app.

### Changed
- Zapstore lists Armada's Linux, Windows and macOS downloads, not only Android

## [0.64.5] - 2026-10-06

A text size slider in Appearance settings, Copy link on links, and Jump to
message from search results. The server rail is wider and easier to scroll on
touch, Android back closes overlays instead of leaving the page, call audio is
cleaner in mono, and searching message history is faster.

### Added
- A Text size slider in Settings → Appearance, saved per device
- Copy link in the message menu when right-clicking a link
- Jump to message in search result menus
- Link previews for profile and community invite links show Armada-branded cards

### Changed
- The server rail is wider on touch, scrolls when dragged from between or diagonally across entries, and taps land reliably after a fling
- Android back closes Settings, the profile overlay, wizards, the new-post pane, the mesh roster and search bars instead of leaving the page beneath
- Noise suppression runs in mono and the microphone is sent as mono audio, keeping the chosen microphone when audio processing is toggled
- Android call sounds open as voice-call audio, and the incoming-call notification is dismissed when you answer, decline or join from the app
- Searching direct message and community history is faster, and typing in the composer does less work
- The Servers section is gone from Settings; servers are added and left from the server rail

### Fixed
- Notification settings are ready immediately for new accounts and no longer stay unavailable when one relay is slow to answer
- Long-pressing inside a menu or popup no longer also long-presses the message behind it
- Community list backups retry less aggressively while a relay is out of date

## [0.64.4] - 2026-10-05

The cut-corner look now covers the whole client: popovers, menus, dialogs,
cards, pickers and search fields share one style and a common desktop layout
grid. Screen-share audio is captured in stereo, calls hold up better in the
background, attachments in disappearing conversations expire on the server,
and long timelines scroll more smoothly.

### Added
- Attachments sent in conversations with disappearing messages ask the file server to delete them after the timer runs out
- A moderation submenu on messages and members, with confirmation before changing someone's staff role

### Changed
- Popovers, menus, autocompletes, dialogs, cards and embeds use the cut-corner design, and the server rail, sidebars, member list and DM rows line up on a shared layout grid
- Emoji, GIF, sticker, game and member pickers share one search field and cut-corner tabs and tiles; on touch, the GIF button folds into the picker's tabs while typing
- The GIF panel keeps the emoji panel's height, and the desktop + menu uses the standard dropdown
- Settings text is shorter and the zap success screen is calmer
- Screen-share audio is captured and sent in stereo without voice processing
- Calls keep their timing when the app is in the background, Android holds Wi-Fi awake during calls, and hanging up a DM call reaches the other side faster
- Long message timelines re-render and scroll with less work

### Fixed
- No leave sound plays when your own call reconnects
- On Linux desktop, the screen-share audio helper no longer lingers after quitting
- Context menus keep their layout while closing
- The Concord timeline stays put when jumping to a message it already shows, and mobile side panels are no longer see-through
- The zap pill's touch padding matches the reaction pill

## [0.64.3] - 2026-10-04

Screen shares in calls are now opt-in: you choose which streams to watch, and
streamers carry a LIVE badge. Voice-only group calls dock as large avatars like
DM calls, one-on-one calls start with the microphone on, and menus, tooltips
and toasts get the cut-corner look.

### Added
- Watch other people's screen shares only when you choose to, and stop watching from the stream tile; streamers show a LIVE badge in the call roster and on their tiles
- The DM list search suggests people you follow but haven't messaged yet
- An Android setting for whether back from the revealed list pane leaves the app or walks back through history

### Changed
- Voice-only group calls dock as large avatars sized to the room, keeping streamers, raised hands and recent speakers on screen ahead of join order
- One-on-one calls join with the microphone on
- Reactions in a call float over the call view
- On a phone, only the bottom call bar hides while the call is docked
- Menus, tooltips, dropdowns and notifications are drawn with cut corners
- File attachment cards fill the width of the message, and copying event JSON happens inline with confirmation
- The call keeps the screen awake only on touch devices

### Fixed
- An interrupted swipe (pane reveal or swipe-to-reply) is cancelled instead of taking effect
- Member list rows load reliably while scrolling
- Message action menus no longer start with a stray separator

## [0.64.2] - 2026-10-04

The docked call now fits its content and carries its own controls, with a
compact strip for voice calls and a side-by-side view for voice DMs. Android
gains an in-call output picker and steadier call audio, back closes the open
menu or dialog, and profile pictures can be encrypted and carry fallbacks.

### Added
- Pick the call's audio output (speaker, earpiece, headset, Bluetooth) from the in-call audio menu on Android 12+
- The ongoing-call notification on Android shows a timer and a mute button
- Profile pictures and banners record their size and a preview, list fallback copies, and can be encrypted
- The reply banner in the composer shows the text of the message being replied to
- Settings search opens from a magnifier in the header

### Changed
- The docked call sizes itself to the call: a one-row strip for voice, both people side by side for a voice DM, and a resizable stage only while there is video; it carries the call controls itself
- On a phone, video calls open full screen with controls that hide on their own, and DM calls read "Calling…" until the other person joins
- Relay-hosted server channels share the community chat header, showing the channel's description or topic
- Git issues and pull requests open in the same thread panel as chat threads
- "Start minimized" only appears when "Launch on startup" is on
- The tab's badge counts only direct messages and mentions
- On touch screens, a composer that wraps moves onto its own full-width row
- Tighter, simpler wording across settings, onboarding, communities and calls
- Remote signer requests are re-sent unchanged for a while before being signed again, and Amber is launched at a pace it accepts
- Sign-in prompts from relays are spaced out per relay, for at most a minute

### Fixed
- Android back closes the open menu, dialog, sheet or emoji picker instead of leaving the screen, and returns to the inbox from message requests
- Call audio on Android stays in call mode through rejoins and settings changes, and the volume keys control the call
- Typing in the composer no longer makes the timeline jump when it shrinks while you're reading back
- Right-clicking an image in the lightbox no longer opens the message menu
- Mention notifications on Android match correctly
- Your own uploads show right away from the local file
- Community icons in the sidebar appear without waiting to decrypt
- Uploaded photos keep the right orientation on older browsers

## [0.64.1] - 2026-10-03

Themes can be tried on before applying, carry a background image and credit
their creator, and Discover can be narrowed to you, your friends or everyone.
Calls keep the screen awake and recover their audio after an interruption, and
remote signers are retried more gently.

### Added
- Try a theme on before applying it, with background images, a creator credit, and editing or deleting the themes you published
- A You / Friends / The world filter on Discover
- Open-signer buttons for Amber, Clave and Aegis in the remote signer reminder

### Changed
- Theme backgrounds show a heavier tint behind app surfaces
- Discover lists communities from the curated list, you and the people you follow unless "Show all content" is on
- Remote signer requests back off instead of re-sending rapidly, and pending ones are re-sent when a relay reconnects
- Creating a channel on a relay-hosted server waits for the server to confirm it, and channels the server doesn't know are listed under "Not found on this server"

### Fixed
- The screen stays on during calls, and call audio resumes after being interrupted
- New members' avatars and banners in communities are no longer held back
- The member list no longer stays limited to a private channel's members after leaving it
- "Launch on startup" on Windows shows as on when "Start minimized" is enabled, and turning it off works

## [0.64.0] - 2026-10-03

3D models sent in chat can now be turned, flicked and zoomed right in the
message, with a preview rendered when you attach one. Community messages and
joins that haven't reached a relay yet are tracked with a Retry button, voice
calls rejoin on their own after a dropped connection, and held media can be
loaded for a whole session or always from hosts you trust.

### Added
- 3D model attachments (glb, gltf, stl, obj, ply, 3mf, fbx, dae) open in an interactive viewer on tap, and attaching one uploads a rendered preview
- Community messages and joins show as pending until a relay holds them, and as failed with Retry if none does; they are re-sent when the app reopens or reconnects
- Trust a media host with "Always load", and Load reveals a host's media for the rest of the session
- A "Preferred media server" setting picks which of your media servers your uploads link to, with the others kept as backups
- A notice with Retry in the sidebar when your community list can't be unlocked, or your signer can't decrypt it

### Changed
- Voice calls rejoin automatically after an unexpected disconnect instead of hanging up, show Leave while reconnecting, and a direct call waits a minute for the other person to come back
- Media from unknown hosts waits for Load whatever your sender setting, unless you use a media proxy; forum posts and avatars follow the same rules, and notification avatars follow the setting
- Media settings are split into privacy and uploads
- Remote signers are reminded once per stall rather than for every signature, and get five minutes to approve
- Back from an open conversation list on Android sends the app to the background
- Android's default microphone and earpiece are labelled "Automatic" and "Phone earpiece" in the device pickers

### Fixed
- Call audio resumes when the browser pauses it mid-call
- Noise suppression no longer breaks when the microphone restarts during a call
- Muting a community on Android applies to every notification it should
- Browser notifications show sender and mentioned names even when their profiles weren't loaded, and no longer turn links containing Nostr addresses into names

## [0.63.4] - 2026-10-01

Communities now hold images, videos, previews and avatars from people you
don't know yet until you choose to load them, so a stranger's message can't
reveal your address to an outside server. Admins can promote and demote
members straight from the profile card and member list, banned members no
longer flash up while a community loads, and the Android download is smaller.

### Added
- Media from community members you have no history with waits behind a Load button; a new setting chooses between trusted senders only, always, or never
- New members' avatars and banners in communities stay hidden for their first hour
- Media hosted outside your own media servers and well-known Nostr hosts waits for Load, with a setting to turn this off
- Make someone an admin or moderator, or remove their role, from their profile card or the member list

### Changed
- Reactions, audio, embeds and notification avatars in communities follow the same media hold
- The member list toggle and the empty-calendar button moved into the channel menu, and member search shows inline
- Community notification icons are sent smaller, and new community icons and banners are stored at a smaller size
- The Android app download is smaller
- Silent "messages synced" entries appear for every suppressed push notification in browsers that require one

### Fixed
- Messages, threads, feeds and search in a community no longer briefly show banned members while moderation is still loading

## [0.63.3] - 2026-09-30

Links to relay-hosted groups shown in chat now appear as join cards, and older
group address formats can be added. Emoji display everywhere, even on systems
without an emoji font. Forum comments send on Enter when that setting is on,
and web push notifications are quieter and better labelled.

### Added
- Links to relay-hosted groups in chat show as a card you can join from
- Emoji render on systems that have no emoji font installed

### Changed
- Forum comment and reply boxes follow the send-on-Enter setting
- Web push notifications fire only for messages, thread replies and reactions, and name the room even when a community message can't be opened
- Older `host'group` group addresses are accepted when adding a group

### Fixed
- A wide attachment tray in the forum comment box scrolls instead of stretching the box
- Messages and quotes that point to a specific relay are found there more reliably

## [0.63.2] - 2026-09-30

Message formatting understands more markdown, including horizontal rules,
multi-line quotes, quotes containing lists and code, and formatting that spans
links and mentions. Tenor and Giphy links play as GIFs. Marking conversations
read syncs to your other devices with far less data, and reconnecting uses
less bandwidth and battery.

### Added
- Horizontal rules (`---`, `***`, `___`), `~~~` code fences, `>>>` multi-line quotes, underlined headings and backslash escapes in messages
- Tenor and Giphy page links play as GIFs instead of showing a link preview

### Changed
- Quotes in messages can contain lists, code blocks and other formatting, and bold, italics and strikethrough can span links and mentions
- Marking conversations read syncs to your other devices using much less data
- Reconnecting to relays re-downloads less, signs in to each relay once, and resumes repository updates where it left off
- Android background notifications pause syncing from a relay that floods them with large settings updates

## [0.63.1] - 2026-09-29

Emoji packs can now be edited in place, with folder drop to add images and drag
reordering, and dragging servers in the rail feels smoother. Replies show their
original message even when it is far back in history. On Android, background
notifications reconnect more gently on flaky networks and catch up correctly
after long disconnects, and several server list and group settings edits no
longer drop existing data.

### Added
- Edit emoji packs in place: drop a folder of images to add them, drag rows to reorder, and see your published packs in settings

### Changed
- Dragging servers in the rail picks up immediately with a mouse, scrolls at the edges more accurately, and animates into place
- Replies to older messages show the original even when it isn't loaded, and jumping to it scrolls back to find it
- Replies in relay-hosted server chats are compatible with other clients
- Android background notifications use less data and battery when another device syncs a lot of changes, and wait for the network to settle before reconnecting

### Fixed
- Android background notifications catch up on direct messages after a long disconnect without re-alerting for old ones
- Joining a community no longer shows mentions and notifications from before you joined
- Editing a relay-hosted group's details keeps the fields you didn't change
- Saving your server list keeps private entries private and public entries public
- Message deletions in relay-hosted groups are only honoured from the author or a group admin
- Malformed relay information no longer breaks server details
- Git repositories are watched on fewer relays without missing updates

## [0.63.0] - 2026-09-28

Browser notifications while Armada is closed now go through a new push service
that works with every way of signing in, including signer extensions and remote
signers, and Armada running inside Tenna gets background notifications too.
Long community channels scroll back faster, the desktop Flatpak offers a web
update restart as a toast, and the Linux .deb installs cleanly on minimal
systems.

### Added
- Background notifications when Armada runs inside Tenna

### Changed
- Browser notifications while Armada is closed use a new push service and work with every login type
- The Flatpak app offers to restart for a web update with an in-app toast, checking once at startup
- Scrolling back through long community channels loads older messages faster, and new messages no longer re-read the whole history
- Typing indicators in direct messages use fewer relay connections
- The landing page animates more smoothly and pauses animations that are off screen
- Upgrading directly from versions older than 0.50.0 is no longer supported

### Fixed
- The Linux .deb declares the audio and graphics libraries it needs

## [0.62.3] - 2026-09-28

A security and reliability release. The Flatpak desktop app verifies its web
updates against the signed site before installing them, media links and CI log
links are checked more strictly, and server invite links fill in their invite
code so joining takes one click.

### Changed
- Server invite links fill in the invite code and join with a single click
- The Flatpak app installs web updates only from the signed site, checking each download and refusing older versions

### Fixed
- Looking up a linked event no longer fails on relays that require sign-in
- Media links are validated more strictly before loading, including through the media proxy
- Only web links are opened from CI logs
- The iOS app accepts messages only from its own page

## [0.62.2] - 2026-09-28

A polish and reliability release. Joining or leaving a community now survives
restarts and failed sends, Watch together accepts direct video links, attached
audio files show their title, artist and cover art, and roles can be assigned
straight from a profile card. Sheets and lightboxes close on back, and audio and
video playback is more robust.

### Added
- Watch together accepts direct video links, with tighter playback sync
- Attached audio files show their title, artist, cover art and a waveform in the tray and the player
- Assign roles from a member's profile card
- Emoji pickers link to Discover's emoji packs
- Forum feed rows show a gallery preview of a post's images
- Copy link action on the theme publish confirmation
- Discover explains how its listings are curated
- A tap-to-explain tooltip on the account standing summary
- Back button and Escape on the restore step of setup, with a confirmation

### Changed
- Joining and leaving a community completes even if the app restarts or a send fails partway
- No relay is added by default for direct messages
- Discover finds your own listings on the app relays as well as yours
- The "Get Armada" link is hidden on the landing page inside the apps

### Fixed
- Sheets, lightboxes and the mobile member list close on back and when navigating
- A relay that refuses a read is no longer taken to mean you have no data there
- Audio falls back to its next source correctly when one can't play
- Video fullscreen covers the whole player
- Message action toolbars are no longer caught in text selection
- Dragging channels no longer starts from menus and popups
- The unread badge on the browser tab icon draws reliably
- The profile card scrolls when it's taller than the screen

## [0.62.1] - 2026-09-27

A performance and battery release. Armada does less work while in the
background on Android, direct messages and synced settings catch up with fewer
network requests, and messages load and decrypt faster. The desktop app now
recovers on its own if its window crashes.

### Changed
- On Android the app stays quiet in the background while the notification service is watching, and wakes when calls or media are playing
- Direct messages, message requests and synced settings update with fewer, smaller requests to relays
- Incoming messages are processed and stored faster, with less repeated decryption and signature checking
- Bot detection and member lists only fetch profiles that aren't already cached
- Loading placeholders stop pulsing after a few seconds
- The Fox default avatar is replaced by Hatcat by xaibott

### Fixed
- The desktop window reloads automatically if its renderer crashes
- The Android notification service no longer reconnects to a failing relay early when its settings change

## [0.62.0] - 2026-09-26

Attaching media has been reworked around a new attach sheet with a grid of your
recent photos, a tray of pending attachments, and per-attachment spoilers and
alt text. Direct-message calls placed by both people at once now meet in one
call, and you are warned before calling someone who likely won't ring. Settings
opens as an overlay over the page you were on, dissolved communities disappear
from Discover, and chats, menus and history load faster.

### Added
- Attach sheet with a recent-media grid, long-press preview and an expandable view, plus a tray of pending attachments
- Mark individual attachments as spoilers and give them alt text; spoilered media stays covered in the lightbox and in pins
- Shared themes and emoji packs have their own short links, with a copy-link button on their cards, and shared themes show as cards in chat
- Discover listings for a community are shown in its settings
- A "Use Armada's default relays" option when setting up relays
- Embedded video players can go fullscreen on Android and desktop, with a hint showing how to exit

### Changed
- Settings opens as an overlay on top of the page you were on, and the rail's Settings button closes it again
- Calling each other at the same moment now joins both of you in one call, and you are warned before calling someone whose settings will likely refuse the ring, with options to call anyway or send a message
- Dissolving a community retires its invite links and Discover listings, and dissolved communities no longer appear in Discover or accept joins
- Refreshed profile view: fills the screen on phones with a full-width banner and a cleaner layout
- On desktop the channel composer is focused automatically and typing anywhere goes into it; Reply focuses the composer and Escape cancels a reply
- The unread dot on tabs is now red and sits in the top-right corner
- Upload size limits are now left to your media server, which is checked before uploading
- Existing relay lists are looked up before the app publishes or copies its relays
- Discover searches each relay separately, so one slow relay no longer holds back the listings
- Chats, message menus, dialogs, the member list and the direct-message list respond faster, and older channel history resumes where it left off
- Signing in and returning to the app are quicker, with fewer repeated signature checks and decryptions

### Fixed
- A settings document with one invalid field no longer loses the rest of your settings
- Links and embeds only connect to public secure relays they mention
- Emoji pack icons and forwarded previews now respect the media privacy setting

### Removed
- Legacy theme colors in an older, unvalidated format are no longer applied

## [0.61.2] - 2026-09-25

Links you share now expand into rich preview cards with the full image, post
text, counts and a tap-to-zoom view, and unresolved embeds offer ways to open,
copy or retry them. The channel list and server rail fling when you flick them,
conversations reopen faster on return, and the landing page has been redesigned
with a rotating showcase of the real app.

### Added
- Links expand into rich preview cards showing the uncropped image, post text, reaction counts, favicons and a tap-to-zoom lightbox

### Changed
- Redesigned landing page with a slowly turning showcase of real app screenshots, an interactive quiz, and desktop and phone captures
- The channel list and server rail now fling when you flick them, and a touch catches the motion
- Conversations reopen faster when you revisit them

### Fixed
- Embed and mention lookups now search deeper, and an unresolved embed offers open-in-Ditto, copy-id and retry actions
- Notifications no longer keep watching Concord communities you have left
- Decrypted content is now cleared from memory when you log out

## [0.61.1] - 2026-09-24

A performance release: chats scroll more smoothly because messages no longer
re-render as you move through them, and direct-message conversations reappear
faster when you revisit them. Older direct-message history now loads when you
scroll back, and relays that require signing in to read now connect and load
their content properly.

### Changed
- Chats scroll more smoothly — messages no longer re-render as you move through a channel
- Direct-message conversations open faster on return, and signing in and syncing are quicker

### Fixed
- Older direct-message history now loads as you scroll back, instead of stopping at the most recent window
- Relays that require signing in to read now connect and reload their content once authenticated

## [0.61.0] - 2026-09-22

A new media privacy setting can load every image someone else sent through a
proxy, so the server hosting it never learns your address; it is off by default
and takes your own list of proxies. Community staff can kick, ban and unban
straight from a member's profile card, and a private-channel key granted with a
role now applies by itself instead of waiting behind an invite. Signing in is
quicker and no longer shows a default theme before your settings arrive.

### Added
- Media privacy setting: load images other people sent through a proxy so the host never sees your address, with your own proxy list to rotate through (off by default)
- Kick, ban and unban a member from their profile card, wherever you tap their name or avatar
- A private channel key that staff send with a role grant now applies automatically, so the channel just appears

### Changed
- Two signup avatars replaced with submitted artwork: Gamer Kitty by dudsflausino and Rose by Milo, and Milo's other avatar is now titled Agent Flower
- The app's description on the web page, the web app manifest and the Linux desktop entry now describes encrypted communities

### Fixed
- Signing in is faster and waits for your settings, so the app no longer opens on a default theme or relay set before yours load
- Desktop notifications on Windows now appear reliably and flash the taskbar
- Both voice surfaces now apply the same microphone settings
- A background relay whose server keeps returning an error is set aside instead of being retried indefinitely

## [0.60.2] - 2026-09-18

The zap dialog is reworked: amounts show in your display currency, Bitcoin is the
default, and more payment methods are supported. You can add donation and payment
addresses to your profile, and view a profile or copy someone's public key
straight from the direct-message menus. The logged-out homepage gains a playable
sailing sea.

### Added
- Playable sailing sea on the logged-out homepage
- Add donation and payment addresses to your profile so others can pay or zap you across more methods
- View a profile or copy someone's public key directly from the direct-message conversation and message menus

### Changed
- Reworked zap dialog: amounts in your display currency, a Bitcoin default, support for more payment methods, and a loading skeleton while payment options resolve
- Refreshed the default avatar placeholder and onboarding preset avatars

### Fixed
- Login screen now displays correctly instead of being confined within the page
- Desktop app reconnects your relays when the computer wakes, even when the sandbox blocks the resume signal
- Communities that are notifying you stay connected so their notifications keep arriving
- Invite previews no longer show a member count that could be inaccurate

## [0.60.1] - 2026-09-17

Fixes the desktop app failing to start.

### Fixed
- Desktop app no longer crashes on launch

## [0.60.0] - 2026-09-17

Communities can now have forum channels: titled posts with threaded comments,
alongside the usual chat. Signing up leads with creating an account and walks a
cleaner key-save and profile flow, you can choose whether Enter sends a message
or adds a line, and the desktop app can launch at login and reconnects your
relays when your computer wakes. Logging out and switching accounts are now fast
and reliable, with a full-screen overlay while it happens.

### Added
- Forum channels: create a channel for titled posts with threaded comments
- Toggle whether pressing Enter sends a message or starts a new line, with a default suited to your device
- Desktop app can start automatically at login, and reconnects your relays when the computer resumes from sleep

### Changed
- Signing up now leads with creating an account and has a reworked key-save and profile flow, with new preset avatars that credit their artists
- Logging out and switching accounts are fast and guaranteed, showing a full-screen overlay until they complete
- Editing a message keeps its original disappearing-message expiration instead of resetting it
- Inline image embeds have slightly less rounded corners

### Fixed
- Replies on Buzz relays now post through the thread, and refreshing drops channels the relay no longer lists

## [0.59.20] - 2026-09-11

Switching channels and scrolling chat are smoother, signing in reaches your
messages faster, and custom emoji from packs you don't already have now show up
instead of staying blank.

### Changed
- Channel switching and chat scrolling are smoother, with less work repeated as you move around
- Signing in now runs its sync steps together after finding your relays, so your messages appear sooner

### Fixed
- Custom emoji from a pack you don't have are now fetched from the sender's own relays, so they display instead of showing nothing

## [0.59.19] - 2026-09-10

Streamable links now play inline, tapping an emoji in a message opens the pack
it came from, Discover loads in pages so it stays smooth, and a handful of media
and screen-share fixes round it out.

### Added
- Streamable links embed as an inline video player
- Tapping an emoji in a message opens a popover showing the pack it came from

### Changed
- Discover feeds now load in pages and defer off-screen cards, so the page stays responsive
- Screen sharing with audio on the web now removes the call's own sound, and stream details show whether audio is included

### Fixed
- Audio message waveforms no longer push the duration out of view
- Videos that can't be played now show a download card instead of a blank frame
- Attachments are recognised by their file extension when the browser doesn't report a type
- All-day dates in the date picker no longer shift by a day across time zones

## [0.59.18] - 2026-09-10

Sharing your screen with audio on Windows now includes system sound again while
still leaving the call itself out, so it no longer falls back to sharing video
only.

### Fixed
- Windows screen sharing now captures system audio minus the call, so a share with audio works instead of dropping to video-only

## [0.59.17] - 2026-09-10

Screen sharing now withholds its audio on platforms that cannot guarantee the
call itself is left out, closing the last way other participants' voices could
leak into a shared screen, and Windows desktop notifications now appear in the
Action Center with the right app name and icon.

### Fixed
- Screen-share audio is now withheld unless your system can confirm it excludes the call, so other participants' voices can never be captured into a shared screen
- Windows desktop notifications now reliably appear in the Action Center, attributed to Armada instead of being dropped or mislabelled

## [0.59.16] - 2026-09-10

Screen sharing with audio during a call no longer echoes other participants'
voices back to them, the landing page gains a download link, and close buttons
get a lighter look.

### Added
- A download link in the top-right corner of the landing page

### Changed
- Softened the appearance of close buttons by dropping their hard borders

### Fixed
- Sharing your screen with audio during a call no longer plays the other participants' voices back to them

## [0.59.15] - 2026-09-08

Desktop notifications now actually appear: the app shows a banner for messages
that arrive while it is open, the Flatpak build reaches the system notification
daemon, and Settings offers the notifier that works on desktop instead of a
toggle that never could. Sender avatars render correctly, a room stops
re-listing messages you have already read, and the Linux app ships a refreshed
launcher icon.

### Fixed
- Desktop notifications for messages received while the app is open now show a banner instead of silently doing nothing
- The Linux Flatpak build's notifications now reach the system notification daemon
- Notifications for messages you are not currently looking at are no longer suppressed on desktop
- Animated GIF sender avatars now render on desktop instead of showing blank
- A room's notification no longer re-lists messages you have already read once you catch up to them
- Refreshed the Linux launcher, window, and taskbar icon
- The desktop app more reliably serves the newest interface bundle after a shell update

### Changed
- Desktop notification settings now offer the foreground notifier that works there rather than a Web Push toggle that cannot function on the desktop shell

## [0.59.14] - 2026-09-07

Desktop update reliability fixes: after the app updates itself, it no longer
keeps showing an older version of the interface, and a fresh launch now checks
for an update as soon as it can instead of potentially waiting hours.

### Fixed
- The desktop app now shows the newer interface bundled with a shell update instead of continuing to serve a previously downloaded one
- A cold start no longer skips its update check and wait hours to try again when it happens before the app is fully ready

## [0.59.13] - 2026-09-07

Linux and Android builds can now be installed and kept up to date through the
Soapbox package repositories — APT and Flatpak on Linux, F-Droid on Android —
so the downloads page offers your package manager instead of a one-off file.

### Added
- Install and auto-update Linux (APT, Flatpak) and Android (F-Droid) builds from the Soapbox package repositories, with the commands to add them shown on the downloads page

### Changed
- The downloads page now installs the Linux Debian and Flatpak builds through those repositories rather than offering them as single-file downloads

## [0.59.12] - 2026-09-07

Maintenance release covering the Linux Flathub packaging and release tooling.
No user-facing changes.

## [0.59.11] - 2026-09-07

Link previews gain a one-tap copy button, and a post embedded from a link on
another site now points back to that source. Muting a community channel
reliably silences it, a screen share from a source with no audio no longer
mutes your later shares, and a profile link pasted into chat stays clickable
instead of collapsing into a mention.

### Added
- Copy a link straight from its preview card with a button in the corner

### Changed
- A post embedded from a link on another site now leads with a "View on <site>" link back to the original source
- More work (relay verification, sign-in signing, and relay-list reads) moved off the main thread to keep the interface responsive

### Fixed
- Muting a community channel now reliably stops its notifications, including a stray generic alert that could still slip through
- A screen share from a source with no capturable audio no longer leaves your following screen shares silent, and the share button now shows when a share has no audio
- Pasting a profile link into chat keeps it as a clickable link instead of turning it into a mention and dropping the link

## [0.59.10] - 2026-09-06

Pictures, avatars, emoji and file downloads now try every storage server that
might hold them instead of giving up on the first one that is unreachable.
Sharing something from another app into a direct message hands it to the
composer again, and Flatpak desktop builds update themselves in place.

### Changed
- Images, avatars, custom emoji, attachments, Mini Apps and community icons fall back to other storage servers when one is down or missing the file, and a retry restarts the search
- Flatpak desktop builds update in place instead of waiting on a separate package repository

### Fixed
- Sharing content from another app into a direct message now fills the composer instead of opening it empty
- Repeat shares to the same conversation no longer show up as duplicate suggestions

## [0.59.9] - 2026-09-06

Chat message verification now runs off the main thread, so busy conversations
stay smooth, and adding a relay works again on older Android devices.

### Changed
- Message signature checks now run in the background, keeping the interface responsive in busy conversations

### Fixed
- "Use this relay" and relay reads no longer fail on older Android devices

## [0.59.8] - 2026-09-06

Screen sharing with audio no longer echoes the call back to itself, plus a
small notification-icon refinement.

### Changed
- Push notifications now show the same simplified mark as the Android status-bar icon

### Fixed
- Sharing your screen with audio while listening on speakers no longer captures and republishes other participants' voices back to the call

## [0.59.7] - 2026-09-04

Further work on Flatpak desktop updates, plus internal release-tooling fixes.

### Fixed
- Continued fixes to how Flatpak desktop updates are published

## [0.59.6] - 2026-09-03

Screen sharing can now include audio from the shared screen or window, with a
toggle in the quality dialog. If the chosen source has no sound Armada can
capture, it offers to share without audio instead of failing outright. Flatpak
desktop builds can find and install updates again.

### Added
- Screen sharing can capture audio from the shared screen or window, with a "Share audio" toggle; if a source has no capturable audio, Armada offers to share without it instead of stopping at an error

### Fixed
- Flatpak desktop builds find and install new versions again when checking for updates

## [0.59.5] - 2026-09-03

A round of behind-the-scenes tuning that trims redundant background refetching
for a lighter, snappier app. Links written without an http/https prefix now
render correctly, and Buzz agents' job output reads as ordinary messages from
the agent.

### Changed
- Buzz agents' job output now appears as ordinary messages from the agent, with author, avatar, reactions and threading

### Fixed
- A link written without an http/https prefix no longer turns an embedded id into a stray mention, and an id in the middle of a link stays part of the link

## [0.59.4] - 2026-09-02

The community settings channel organizer gets a proper reordering experience:
press and hold a channel to drag it, follow a drag grip on each row, and the
list auto-scrolls when you drag near an edge. Each channel row's actions now
tuck into an overflow menu for a cleaner layout. Scrolling to a linked message
now keeps loading older history without needing a second scroll.

### Added
- Press and hold to drag and reorder channels in community settings, with a drag grip on each row and auto-scroll when dragging near the edges

### Changed
- A channel row's actions in community settings now collapse into an overflow menu

### Fixed
- Jumping to a linked message continues loading older messages without a second scroll gesture

## [0.59.3] - 2026-09-01

Direct messages can now be turned off entirely — the DM inbox, its settings, and
its command-palette entries all disappear while it's off. Invite links to
relay-hosted servers now open as cards right in the chat, and short invite codes
without a dot are accepted. The Wallet settings stay reachable even with zaps
turned off, a channel you've left no longer resurfaces in the list, and
relay-server timeline rows read a little cleaner.

### Added
- A setting to turn off direct messages entirely, hiding the DM inbox and all its controls

### Changed
- Invite links to relay-hosted servers now appear as cards directly in the chat, and short invite codes are accepted
- Relay-server timeline rows are cleaner without the inline reply-context line

### Fixed
- The Wallet settings entry stays reachable when zaps are turned off
- A channel you've left no longer reappears in the list from stale cached data

## [0.59.2] - 2026-09-01

Instagram posts now unfurl into rich embeds in chat, and timestamps read
naturally past a few days as weeks, months and years. Shared links drop their
tracking parameters as they land in the composer, and a shared payload now goes
to the room you're actually in. Notification sounds play reliably when a message
arrives, the DMs unread dot no longer lights for strangers, and the desktop
Flatpak build can update itself in place.

### Added
- Instagram posts shared in chat now show as rich embeds

### Changed
- Relative timestamps now extend past days to weeks, months and years
- Shared links have their tracking parameters stripped as they enter the composer
- The desktop Flatpak build can now update itself in place

### Fixed
- The in-app notification sound now plays when a message arrives
- The DMs unread indicator no longer lights up for people you don't know
- A shared or forwarded message now goes to the room you have open rather than the wrong one

## [0.59.1] - 2026-08-30

Fixes a freeze on mobile when opening a link or notification that jumps to a
specific message: the app kept rendering but stopped responding to touch until
it was force-quit. Jumping to a message from a notification now also closes the
channel list so the message you were sent to is actually on screen.

### Fixed
- Opening a link or notification that jumps to a specific message no longer leaves the app unresponsive on mobile
- Tapping a notification for a channel in the community you already have open now closes the channel list and lands on the message

## [0.59.0] - 2026-08-29

Mini Apps now work inside direct messages, each scoped to its own conversation
so a group DM and a one-to-one keep separate app state. Chat links that point
back into Armada now open in the app as navigable cards instead of leaving for a
browser, and you can mention everyone in a community when you're allowed to.
Moderation gets clearer: hide individual messages just for yourself, block a
person distinctly from muting a channel, and a rewritten Terms page. Joining a
community from an invite is now instant.

### Added
- Mini Apps in direct messages, each scoped to its conversation so group and one-to-one chats keep separate app state
- Mention everyone in a community with @everyone, where you're authorized to
- Chat links to a message, channel, community or profile on Armada open in the app as a navigable card instead of a browser, showing the destination and, when it's on your device, the sender and message
- Hide an individual message just for yourself, undoable from the toast
- Copy a chat image straight from the message or the lightbox

### Changed
- Joining a community from an invite opens it immediately while the rest completes in the background
- The person-level mute is now labelled Block/Unblock, distinct from muting a channel's notifications
- The Terms page now spells out what the terms cover, the acceptable-use policy, and the moderation tools each side holds
- The lightbox's copy, save and share moved to a right-click menu on the image
- On Android, share suggestions are ranked by the conversations you most recently sent to

### Fixed
- Tweet embeds now load instead of being blocked
- A cold tab no longer briefly flashes the wrong half of a direct message before it's ready

## [0.58.0] - 2026-08-26

A new All messages pane gathers every channel in a community into one feed, so
you can catch up in one place. Chat now renders much richer previews: linked
notes appear as proper cards, tweets and Magic card images render inline, and
ordinary links get fuller previews. Direct-call ringing is surfaced in the
conversation header, direct invites arrive instantly instead of on a timer, and
suspicious-activity moderation moves into its own full pane.

### Added
- An All messages pane that merges every channel in a community into a single feed
- Richer chat previews: linked notes render as cards with their real per-type layout, tweets and Magic: The Gathering card images appear inline, and links get fuller preview cards
- A ringing direct call now shows the caller in the conversation header, so you can answer from the chat you're in
- Suspicious activity has its own full moderation pane, which now also flags senders whose messages are dated in the future
- The signup dialog inside the app now includes a profile step, matching the full welcome flow
- A setting to cap and turn off the automatic recent-direct-message strip in the sidebar

### Changed
- Direct invites arrive the moment they're sent instead of after a delay, and the invite inbox shows one row per community
- Messages dated in the future are held until their time actually arrives and no longer trigger a notification or unread count
- Replies stay ordered directly after the message they answer, even when clocks disagree
- On narrow screens, settings controls stack below their label instead of crowding it
- A message still sending shows a gentle pulse across the whole row instead of a spinner

### Fixed
- Emoji shortcode autocomplete replaces the right text even after you move the cursor
- The profile picker closes as soon as you choose a profile
- Copied message and invite links open in the desktop app's own window instead of a browser
- A community that dissolves while you're viewing it keeps its page in place instead of throwing you back home, and an active call keeps running through the dissolution and ends cleanly when the other person leaves

## [0.57.1] - 2026-08-23

Invite links now ask before they join. Opening one shows the community first —
its name, artwork, channels, relays and who is already inside — and you join
only when you accept it. Being removed from a community also takes effect right
away instead of waiting on a background refresh, and on Android incoming
messages are handled off the app's main thread, so receiving them no longer
slows the interface.

### Changed
- Opening an invite link shows the community and asks before joining, instead of joining the moment the link opens. Signed out, the same preview offers a sign-in button, so you can see what you are accepting before making an account

### Fixed
- Being removed from a community applies right away, and the community drops off the sidebar without waiting on a background refresh
- On Android, messages arriving in the background are handled off the app's main thread, so receiving them no longer slows the interface

## [0.57.0] - 2026-08-23

Chat messages now render richer formatting: fenced code blocks are
syntax-highlighted and carry a one-tap copy button, and headings and simple
lists lay out the way they read. The full-screen sync screen shown right after
signing in is back — it had stopped appearing on a fresh login.

### Added
- Fenced code blocks in chat are syntax-highlighted and have a button to copy their contents
- Headings and bulleted or numbered lists in chat messages render as formatted text

### Fixed
- The post-login sync screen appears again when you sign in

## [0.56.4] - 2026-08-22

Desktop updates now come from the same signed release listing the downloads page
reads, and every download is checked against the hash published with it. The
older update feed and the Flatpak update repository are no longer refreshed with
each release, so a desktop or Flatpak install from 0.56.3 or earlier will keep
reporting itself up to date — install this version once by hand from the
downloads page to pick up later ones automatically.

### Changed
- The desktop app looks for updates in the same signed release listing the downloads page shows, and verifies each download against the hash published with it
- The Flatpak update repository is no longer refreshed with each release. The signed `.flatpak` bundle on the downloads page is how to install and update

### Fixed
- The web app is published with each release again

## [0.56.3] - 2026-08-22

The Android app is published to Google Play again. Since 0.51.2 every upload was
accepted and then discarded at the last step, so the Play listing stayed on that
version while the app shipped everywhere else. Nothing else about the app has
changed in this release.

### Fixed
- The Android app reaches Google Play again, so the Play listing tracks the current version

## [0.56.2] - 2026-08-22

The desktop installers, the signed Flatpak bundle and the downloads page listing are published. In 0.56.1 a rejected app-store upload stopped the rest of the release before any of them went out, so the desktop downloads never appeared.

### Fixed
- The desktop installers, the signed Flatpak bundle and the downloads page listing are published. A rejected app-store upload no longer stops the rest of the release
- A dropped transfer while uploading a large installer is retried, instead of leaving the release without its downloads

## [0.56.1] - 2026-08-22

The desktop installers and the signed Flatpak bundle announced in 0.56.0 are published: that build stopped short of publishing them, so 0.56 shipped no desktop downloads at all. The downloads page now lists earlier versions alongside the current one, and every file is named after the version it installs.

### Added
- The downloads page lists earlier releases alongside the current one, each with its own files

### Changed
- Downloads are named after the version they install. The older unversioned links (`Armada.AppImage`, `Armada.apk` and the rest) are no longer updated, so use the ones on the downloads page

### Fixed
- The desktop installers and the signed Flatpak bundle are published again
- Flatpak's debug-symbol package is signed along with the rest of the update repository, so Flatpak accepts the update instead of refusing it as unsigned

## [0.56.0] - 2026-08-22

This release adds an account-level Notification Center that gathers your mentions across every community and server, plus your pending community invites, into one newest-first list — and surfaces your unread direct-message conversations above the community rail with exact unread counts. Mini Apps can now play multiplayer across Armada and Vector. Screen shares gain a full call-control bar while fullscreen, your community and direct-message lists sync across your devices, and cross-platform notifications are more reliable.

### Added
- A Notification Center collecting your mentions across all communities and servers, plus pending community invites, in one newest-first list
- Your unread direct-message conversations appear above the community icons in the rail, with exact unread counts; reading a conversation clears it
- Mini Apps can play multiplayer across Armada and Vector — the two apps share the same game session
- The full call-control bar stays available while a screen share is fullscreen, with source selection, quality, diagnostics, reactions and menus reachable without leaving fullscreen
- An unread cue on the browser tab's icon when Armada is in the background

### Changed
- Your community list and direct-message conversation list now sync across your devices through your relays, and synced conversations appear before their history finishes loading
- Being removed from a community by a kick now takes its icon out of your rail and ends any live call in it, the same way a ban already did

### Fixed
- Cross-platform notification reliability: Android notification startup and service recovery, a single reliable presenter for web and iOS Home Screen notifications, and notification settings kept scoped to the account that owns them

### Security
- Desktop updates on Linux (Flatpak) are cryptographically signed and verified against a pinned release key

## [0.55.3] - 2026-08-20

A security-hardening release covering three paths where something outside the app chose a value the app then trusted. Answering a ringing call from a notification now joins the call the app itself verified rather than whatever the tap's link spelled out, the accounts listed on an incoming message have to be real accounts before they name a conversation, and saving or sharing media derives its filename safely instead of letting the media address pick where the file lands.

### Security
- Answering a direct-message call from a notification joins the call the app already verified, so a crafted link can no longer drop you into a call with someone who never rang you (Android)
- The accounts listed on an incoming message must be real accounts before they name a conversation, so a crafted message can't steer where a notification tap takes you
- Saving or sharing an image, video or file derives its filename safely, so a media address can no longer decide where on the device the file is written

## [0.55.2] - 2026-08-19

A security-hardening release. Sharing into Armada from another app now accepts only genuine shared content, closing a path by which another app could have had Armada read its own private files, including your decrypted message history. Community push notifications check who really wrote a message before putting a name and face on your lock screen, images and links from other people are checked before they load, and the Bluetooth mesh bounds what a nearby device can make it allocate.

### Security
- Sharing into Armada from another app accepts only real shared content, so an app on the device can no longer use the share sheet to make Armada read its own private files — including your decrypted message history — and stage them into a conversation with the sender (Android)
- A community push notification verifies who actually wrote the message before showing a sender's name and picture, so an alert can't be dressed up as one of your contacts
- Images and avatars supplied by other people — profile banners, relay icons, emoji-pack covers, link previews, the call backdrop — are checked before they are loaded
- The link on someone's status is restricted to ordinary web addresses instead of reaching the page unchecked
- Invite and notification links only open destinations on Armada's own site
- A packet from a device in radio range can no longer claim an unbounded size and exhaust memory over the opt-in Bluetooth mesh
- The app carries a content security policy on every platform, including the mobile and desktop builds

### Removed
- An unused charting component and its dependencies, which also shrinks the app download

## [0.55.1] - 2026-08-19

Two fixes on the security- and money-sensitive paths. A Bitcoin send to a silent-payment address now derives the output from every coin it spends, so a payment from a wallet holding more than one coin reaches the recipient instead of confirming into an address nobody is watching. And remote-signer login over a QR code now only accepts the signer you scanned, closing a window where a relay could slip in as your signer while you were still approving the code.

### Fixed
- A Bitcoin payment to a silent-payment address is now sent correctly when the wallet holds more than one coin, instead of confirming to an address the recipient never sees
- Remote-signer login by QR code accepts only the signer you scanned, so a relay can't insert itself as your signer during approval

## [0.55.0] - 2026-08-19

The quick switcher now finds your direct-message conversations too — search people, groups, and Note to Self by name and jump straight in, reopening a closed thread on the way. The invite screen is rebuilt around a full community preview: the decrypted banner and icon, a members list with the followed people you already know, the relays, and a badge when someone you follow sent the invite. Settings gains a "Pull latest setup" button that reads your saved relay and voice-server records back from your relays, alongside the existing publish. Plus fixes to the in-call bar and floating call preview.

### Added
- Direct-message conversations appear in the quick switcher — search people, groups, and Note to Self, and reopen a closed thread by selecting it
- A "Pull latest setup" button in Settings reads your saved relay and voice-server records back from your relays

### Changed
- The invite screen is rebuilt around a full community preview: banner and icon, a members list highlighting people you follow, the relays, and a badge when the inviter is someone you follow

### Fixed
- The call bar title returns you to an in-progress Concord call
- The floating call preview is positioned correctly
- Toggling the call stage respects the current route

## [0.54.1] - 2026-08-18

Web push notifications for direct messages and community chats now show the real sender and message text even when the notification arrives without it, instead of a generic "New message", and a copy of something you sent from another device no longer leaves a stray alert behind. QR codes — the shared profile code and every other one in the app — render in browsers that block canvas fingerprinting, where they previously came out blank.

### Fixed
- Direct-message and community push notifications show the sender and message text even when the alert arrives without them, rather than a generic "New message"
- A push for a message you sent from another device no longer leaves a stray notification on screen
- Push notifications no longer drop back to the generic wake-up text after a session that didn't finish starting up
- QR codes render in browsers that block canvas fingerprinting (Brave, Tor Browser) instead of appearing blank

## [0.54.0] - 2026-08-18

Tapping a name now opens a full profile view — avatar, bio, follower and following counts, a follow toggle, badges, and the person's own profile theme — and you can share your own profile as a QR code or link from the account switcher. Vector Mini Apps render inline in chat, animated GIF avatars stay animated when you upload them, and login gives a clearer message when an nsec is truncated. YouTube embeds play again in the packaged desktop and mobile apps, desktop auto-updates are back, and an Android notification clears from the tray once you've read the message on another device.

### Added
- A full profile view — avatar, bio, follower and following counts, a follow toggle, badges, and the person's own customizable profile theme — opened by tapping a name
- Share your own profile as a QR code or link from the account switcher
- Vector Mini Apps render inline in chat

### Fixed
- YouTube embeds play again in the packaged desktop and mobile apps
- Uploading an animated GIF avatar keeps it animated instead of flattening it
- Login shows a clearer message when a pasted nsec is truncated
- Android tray notifications clear once the message is read on another device
- Desktop automatic updates are delivered again

## [0.53.1] - 2026-08-17

Videos in chat get a real player — custom controls, a download button, and a save/share menu — and cached images and video thumbnails now appear instantly instead of flashing a placeholder for a frame. Links you send and links in the messages you read are cleaned of tracking parameters. A channel with muted or mentions-only notifications now reads as a dimmed row rather than a corner badge, and long-press on touch no longer misfires the action menu while you swipe to reveal a pane.

### Added
- A full video player in chat, with custom controls, a download button, and a save/share menu
- Tracking parameters (utm_*, fbclid, and the like) are stripped from links you send and from links in the messages you view

### Changed
- A channel with muted or mentions-only notifications now shows as a dimmed row instead of a corner badge

### Fixed
- Cached images and video thumbnails paint on the first frame instead of briefly showing a placeholder
- Long-press no longer opens the message action menu mid-swipe when you drag to reveal a pane on touch
- Per-peer direct-message settings from different devices now merge instead of one device overwriting the other's

## [0.53.0] - 2026-08-16

Armada gains screen sharing you can tune — pick the resolution, frame rate, bitrate, and codec, watch live sender and viewer diagnostics, and go true fullscreen. Voice now belongs to the community: a community can host its own voice servers, chosen when you create it or later in its settings, and everyone's calls resolve to the same place. Incoming direct-message calls ring with a full-screen overlay, and on Android you can answer or decline from the notification even with the app closed. Discover shows how active each community is, communities gain a right-click "Mark as read", and pressing Up in an empty composer edits your last message.

### Added
- Screen sharing with configurable quality — resolution, frame rate, bitrate, and codec controls, with live sender and viewer diagnostics and true fullscreen playback
- A community can host its own voice servers, set when you create it or later under its settings, so everyone in it calls to the same place
- Incoming direct-message calls ring with a full-screen overlay, and on Android you can answer or decline from the notification even when the app is closed
- Community cards in Discover show how active each community is
- "Mark as read" for a whole community or server from its right-click menu
- Press Up in an empty composer to edit your most recent message

### Changed
- A channel shows a small badge when its notifications are muted or set to mentions-only

### Fixed
- Messages from banned members are now hidden from search, threads, and unread counts too

## [0.52.2] - 2026-08-14

You can now follow people straight from their profile card, with mute, report, and unfollow tucked into a menu so the card leads with Message, Mention, and Follow. Private channels let you name their access role and add more roles later, and you can add members right from the channel header. Jumping to a message from search now lands on the exact message across communities, servers, and direct messages, with older history filling in as you scroll up. Rounding it out is a batch of touch and navigation fixes.

### Added
- Follow anyone directly from their profile card
- Name a private channel's access role when you create or make it private, and add more access roles to it later
- Add members to a private channel from its header menu

### Changed
- The profile card leads with Message, Mention, and Follow; mute, report, and unfollow move into a "…" menu on the card
- Private channel roles show a lock badge, a member count, and clearer access wording in the role editor

### Fixed
- Jumping to a message from search lands on the exact message across communities, servers, and direct messages
- Direct message history grows as you scroll up, and newly loaded older days appear at the top without the view jumping
- The message action menu closes when you press Android's back button
- Long-press is steadier on touch, and the back-swipe gesture no longer fires when you press on a menu or overlay
- The people list in the invite dialog can now be scrolled

## [0.52.1] - 2026-08-14

Each account on a shared device now keeps its own conversations and layout to itself, and switching accounts reloads cleanly into the one you picked. Message images gain their own actions — long-press or right-click a picture in chat to open, save, or share it alongside the usual message actions — with the long-press gesture made more reliable on touch. Web apps can now be up to 500 MB.

### Added
- Long-press or right-click an image in chat to open its own menu — open, save, or share the picture — together with the message's actions

### Changed
- Web apps can now be up to 500 MB

### Fixed
- Each account on a device keeps its own conversations, pinned chats, and rail arrangement, so signing into a second account no longer shows or republishes the first one's chats
- One account's messages no longer leak into another's view when visiting a community link
- Switching accounts, and logging out with others still signed in, reloads cleanly into the right account

## [0.52.0] - 2026-08-13

Direct messages can now include several people at once: pick the recipients in the compose pane, and the conversation carries everyone's names and faces. Armada is on Google Play and Zapstore, linked from the landing and downloads pages. Video attachments preview before you send them, play full-window in the lightbox, and loop inline. Communities gain kick and ban from the message menu, Android shows an ongoing-call notification, and direct message sync now recovers relay by relay.

### Added
- Group direct messages — pick several people with "New group" in the compose pane; the conversation is titled with everyone's names and shows their faces together
- Install buttons for Google Play and Zapstore on the landing and downloads pages
- Video attachments preview in the composer before you send them
- Kick and ban a member straight from a message's context menu in a community
- Broadcast relays, editable in settings and defaulting to relay.primal.net, that your profile and other public posts are also sent to
- Automatic settings sync, with a switch to leave a single device out of it, plus shared app DM relays and media servers carried across your clients
- An ongoing-call notification on Android, with a Leave action, that keeps a call running while you're in another app
- Editing your profile from the account switcher
- Community unread counts in the desktop app's badge

### Changed
- Video attachments play full-window in the lightbox instead of a dialog, and inline videos loop
- The landing page's closing sections are grouped into one screen with store buttons
- Voice calls capture mono audio
- Swiping and rail navigation on mobile are smoother, no longer re-rendering as you drag

### Fixed
- Direct message sync recovers relay by relay, so one failing or slow relay no longer stalls the rest, and a full catch-up runs when you reconnect
- Direct message inboxes are discovered across more of your relays, and people using other clients are no longer marked as unable to receive messages
- Encrypted media that can't be decrypted now fails instead of loading the file unencrypted, and very large attachments ask before decrypting
- Rapid settings changes, such as rearranging the server rail, no longer revert each other
- A channel's unread badge clears when its newest message is deleted, expired, or from a banned member
- Voice calls no longer reuse a cached token for a different room, and a failed encryption setup shows an error instead of joining unencrypted
- Channels set to mentions-only are honored by push notifications on iPhone and iPad
- The Android battery optimization prompt is a one-time offer instead of a daily nudge
- Opening a link into the app holds the splash until the destination is ready, instead of flashing a default screen first
- A swipe interrupted by switching apps no longer leaves the pane stuck partway
- Discover keeps its last good results when a fetch comes back empty
- The message action toolbar is no longer clipped in search results and mention rows
- Poll composing can be exited, and editing a message puts the cursor at the end
- Saving a file attachment works in the app builds
- Banned members' messages no longer raise notifications

## [0.51.2] - 2026-08-11

Reactions in a voice call now float up the full window so everyone in the call sees them. The post-login sync screen is restyled as a jack-in sequence, editing a community's picture reuses the same crop tool as creating one, and an empty channel now reads as still loading rather than claiming the relays are unreachable. Deleted private channels no longer reappear, and emoji autocomplete works right after a native emoji with no space before the colon.

### Changed
- Reactions sent during a voice call now float up the full window and are seen by everyone in the call
- The post-login sync screen is restyled as a jack-in sequence
- Editing a community's picture opens the same crop tool used when creating one
- An empty channel now shows as a timeline still loading, with the background retry kept visible, rather than reporting the relays as unreachable

### Fixed
- Deleted private channels no longer reappear
- Emoji autocomplete now triggers on a shortcode typed right after a native emoji or other text with no space before the colon

## [0.51.1] - 2026-08-10

Media in chat now tries each of your Blossom servers before showing a placeholder, and a failed send clears once any relay accepts the retry. Inline images no longer shift the timeline as they load. The audit log adds a "View event JSON" option, and the Android notification background service handles malformed relay addresses without crashing.

### Added
- Media that fails to load is tried on each of your other Blossom servers in turn before showing a placeholder card; Tenor and Giphy clips load as video
- "View event JSON" is available on audit log rows, behind the same right-click or long-press as chat messages

### Fixed
- A failed chat message clears once a relay accepts the retry
- Inline chat images reserve their space before loading so the timeline no longer shifts
- The Android notification service skips blank or malformed relay entries rather than crashing the background worker

## [0.51.0] - 2026-08-10

Push notifications come to iPhone and iPad, decrypted on your device — the sender, the text, and their picture — over the same content-blind gateway used elsewhere, with a tap opening the conversation. A new history tool verifies a community's messages and exports them as a self-contained web page, letting you pick channels and a time range. Creating a community is now a guided full-screen wizard, and community settings and moderation each open as a full-page tabbed pane. The downloads page adds Flatpak and copy-ready install commands for the command-line builds.

### Added
- Push notifications on iPhone and iPad, decrypted on your device — the sender, the text, and their picture — over the same content-blind gateway used on other platforms, with a tap on a direct message opening straight to the conversation
- A history tool that verifies a community's messages and exports them as a self-contained web page, with channel selection and a time range, leaving out disappearing and deleted messages
- The downloads page lists Flatpak and shows copy-ready install commands for the command-line builds
- A speaker glyph marks a channel that has a live voice call

### Changed
- Creating a community is now a full-screen guided wizard, opening on the text channel step
- Community settings open as a full-page tabbed pane instead of a dialog
- Moderation tools are consolidated into one tabbed panel
- The Discover page is centered in a bounded column with its three-column grid restored, and its mobile tabs and search match the server rail
- The server rail shows its settings divider only when the list overflows

### Fixed
- The desktop app now quits cleanly instead of hanging on exit
- The Discover community list no longer collapses to empty when a fetch is dropped

## [0.50.3] - 2026-08-09

Notifications now carry the message itself: who sent it, what they said, which conversation it belongs to, and the sender's picture — all decrypted on your device, across background push, in-app, and desktop alerts, and grouped per conversation. Turning notifications off now takes effect immediately, and messages you sent from another device no longer buzz you. Large member lists and DM lists also scroll smoothly.

### Added
- Notifications show the message itself — the sender, the text, the room or community it belongs to, and the sender's picture — decrypted on your device, for background push, in-app, and desktop alerts, with alerts grouped per conversation

### Changed
- Notifications no longer alert you to your own messages sent from another device, or to reactions meant for someone else

### Fixed
- Turning off notifications now takes effect immediately, and notifications honor your system's notification permission
- Large member lists and DM conversation lists scroll smoothly, rendering only the rows in view
- Mention names resolve more reliably, and the app stops re-requesting a profile that keeps coming back empty
- Duplicate messages are dropped before they can flicker into a conversation
- The Bluetooth mesh keepalive service no longer risks being killed at startup under the system's foreground-service deadline

## [0.50.2] - 2026-08-09

Settings sync is now split into separate documents per category, so a read-state update no longer rewrites all your other preferences. Several settings that were silently dropped on reload now sync across devices correctly.

### Fixed
- DM typing indicators, DM request visibility, default zap amount, zap method, and zaps enabled now sync across devices; they were silently discarded on reload before this release
- Read state and reactions no longer cause all other settings to be rewritten when they change; each settings category is now a separate synced document

## [0.50.1] - 2026-08-09

Spam floods no longer drown a channel: coordinated waves of junk — repeated templates, rotating pitches, sudden swarms of new accounts, and established accounts taking turns posting fluent spam — collapse into a single expandable row instead of filling the timeline. Nothing is deleted, and your own messages, community staff, and people you've interacted with are never folded. Community staff can now pause a community from the channel menu, and direct invites arrive in a routed inbox with its own badge instead of a one-at-a-time popup.

### Added
- Spam floods collapse into a single expandable timeline row you can click to reveal, covering repeated messages, near-duplicate rotating pitches, sudden waves of newly arrived accounts, coordinated groups posting in turns, and established accounts drowning a channel with unique spam; nothing is ever deleted, and your own messages, community staff, and people you've talked to are always left in place
- Community staff can pause a community from the channel menu for a set duration or until they resume it; while paused the composer is disabled and non-staff messages are collapsed away
- Direct invites now arrive in a routed inbox with its own rail entry and unseen-count badge, replacing the one-at-a-time popup, with a passive toast that points you there

### Changed
- Flood-collapsed messages no longer raise unread or mention badges, and message notifications are rate-limited per room so a spam burst can't repeatedly buzz your device; people you follow are exempt from the limit

### Fixed
- The Android background notification service no longer risks being killed at startup under the system's foreground-service deadline

## [0.50.0] - 2026-08-08

Muting and reporting land across the app: mute anyone from any menu and they disappear from every surface, or report a message or a person — in a community the report goes privately to its staff, who read the queue in a new Reports pane. Staff can also rotate a community's keys on demand. Git activity in channels is now quiet chat rows instead of bordered cards, and key rotations in large communities and private channels are fixed.

### Added
- Mute anyone from a message menu, thread panel, member list, profile card, DM header or voice menu; muted people vanish from timelines, member lists, reactions, typing indicators, search, mentions, notifications and Discover, and can be unmuted from a new Muted people section in Settings
- Report a message or a person from the message menu, member list, profile card or DM header, with the option to mute them at the same time; reports in a community go privately to its staff, who read them in a new Reports pane
- Staff can rotate a community's keys on demand from the community menu

### Changed
- Git activity in channels renders as quiet chat rows instead of bordered cards, with long bodies trimmed to a preview, back-to-back activity from one person grouped, and stretches of status changes or CI runs folded into a single row

### Fixed
- A Refounding no longer hands every remaining member the keys to private channels they aren't entitled to; each private channel is rotated only to the members entitled to it
- Key rotations in communities with more than roughly 100 members no longer fail to publish
- Rooms set to notify only on mentions no longer notify for every message when the app is in the background on Android
- An interrupted edge swipe no longer leaves a pane stuck partway open

## [0.49.6] - 2026-08-08

Bug fix release: private channels now load from their own keys, and the Linux .deb package is correctly staged in the desktop auto-update feed.

### Fixed
- Private channels now load from their own channel keys instead of the community stream, restoring message visibility for private channel members
- The Linux .deb package is now included in the desktop auto-update feed so .deb users receive automatic updates

## [0.49.5] - 2026-08-08

A maintenance release with build and packaging pipeline improvements. There are no user-facing changes.

## [0.49.4] - 2026-08-08

A maintenance release with build and packaging pipeline improvements. There are no user-facing changes.

## [0.49.3] - 2026-08-08

A maintenance release with build and packaging pipeline improvements. There are no user-facing changes.

## [0.49.2] - 2026-08-08

A maintenance release with build and packaging pipeline improvements. There are no user-facing changes.

## [0.49.1] - 2026-08-08

The desktop app gains push-to-talk, application audio capture in screen shares on Linux, Flatpak packaging, and automatic updates. The Linux build now minimises to a system tray icon instead of quitting when the window is closed. Several notification fixes land alongside: duplicate pushes are filtered, the sender name fills in correctly, and the first tap on the send button now sends.

### Added
- Push-to-talk on desktop: a configurable global shortcut mutes and unmutes the microphone during a call, with Wayland portal support
- Screen share audio on Linux: application audio sources appear alongside the display, and the active audio track switches when you pick a new source
- Flatpak packaging for the Linux desktop app
- Desktop auto-updates: the app checks for and downloads new releases in the background
- System tray icon on Linux; closing the main window minimises to tray rather than quitting
- Android store links and an iOS app teaser on the Downloads page, which has been redesigned with a platform-first layout

### Fixed
- Web push notifications are deduplicated when the same push is replayed, and the Apple silent-push keep-alive is rate-limited to avoid exhausting the daily quota
- A notification from a sender with no profile now shows "Anonymous" instead of a blank name
- The first tap on the send button now sends immediately instead of needing a second tap to focus the composer
- The notification worker retains a generic conversation title until sender names resolve, preventing a momentary blank heading

## [0.49.0] - 2026-08-07

Direct message notifications were rebuilt. A message from someone you know now arrives with their name, avatar and a preview, gathered into one entry per conversation, while a message from a stranger no longer puts sender-controlled text or pictures in front of you. You can now forward a message to another conversation, and a new Downloads page collects the desktop and Android installers in one place.

### Added
- Forward a message from a direct message to any other conversation — the destination's composer opens with the content, so you can edit it before sending, and an attachment carries across as an attachment rather than a pasted link
- A Downloads page collecting the desktop and Android installers, with the one matching your device shown first, linked from the footer in Settings
- A Message requests setting for direct messages from people you don't follow, offering full notifications, hidden content (the default), or none at all

### Changed
- Notifications for direct messages now show the sender's name, avatar and a preview, and gather a conversation into a single entry carrying its recent lines, in place of a generic "New message"
- Direct messages from people you don't follow collapse into one Message requests notification that shows nothing the sender controls
- Communities now limit how quickly messages can be sent: after a short burst, sending pauses briefly, escalating up to an hour if the flooding continues, with the remaining wait shown when a message is refused

### Fixed
- Share and invite links created in the desktop app now point at armada.buzz; they previously carried an address internal to the app, which did not work for anyone they were sent to
- WebXDC apps on a slow connection now load instead of stalling, downloading the app once rather than repeatedly
- Direct message notifications keep working after a push server changes its keys
- A hidden or backgrounded page no longer swallows a notification the service worker would otherwise have shown

### Security
- The Android app no longer includes the analytics used by the hosted web client
- The key the notification worker uses to read direct messages is now encrypted where it is stored

## [0.48.1] - 2026-08-07

Community relays now have their own dedicated setting, so new communities are created on relays you choose rather than an unlabeled mix of app and DM relays.

### Added
- A Community relays section in Settings to choose which relays new communities are created on

### Changed
- On Android, the nsec keyring backup during onboarding now requires Android 14 or newer; older devices fall back to the existing key file export

## [0.48.0] - 2026-08-07

Armada now ships a macOS desktop app alongside Linux and Windows, and every release keeps a stable download link at armada.buzz/downloads. Replies and quotes were redesigned throughout: the composer shows who you're replying to with their avatar and highlighted name, and a reply in the timeline shows a one-line snippet joined to the message it answers. The original generation of Concord communities has been removed; communities created in current versions are unaffected.

### Added
- A macOS desktop app, alongside the existing Linux and Windows builds (ad-hoc signed, so the first launch needs Open Anyway)
- Every release has a stable download link under armada.buzz/downloads
- An Account standing page in Settings

### Changed
- Reply and quote previews redesigned: the composer bar leads with the author's avatar and an accent-highlighted name, and a reply in the timeline shows the author, avatar and a one-line snippet tied to the message by a connector
- Custom emojis render inside reply and quote previews

### Fixed
- A reply you started is cleared when you switch channel or community, instead of carrying over

### Removed
- The first generation of Concord communities, along with their invites, notifications and the Settings "Recover communities" section. Communities created in current versions are unaffected.

## [0.47.0] - 2026-08-06

Edit a direct message after you've sent it, search a community's member list by name or npub, and share your screen on a voice call with louder playback. New accounts can be seeded onto an operator's relays from a /join link and discover recommended relays automatically, and invites now carry a short description that shows on discover cards. The desktop app keeps your servers in a persistent rail, stores its data more reliably, encrypts your login, and picks up a theme-aware tray icon.

### Added
- Edit a direct message after sending it
- Search a community's member list by name or npub
- Share your screen on a voice call, with a boosted playback volume control
- A /join referral link that seeds a new account onto an operator's relays, plus automatic discovery of recommended relays during setup
- Invites carry a short description that appears on discover cards
- The desktop app keeps your servers in a persistent side rail

### Changed
- Switching channels in a community updates the timeline in place instead of tearing it down and rebuilding it, so it's smoother
- Relay setup and recovery use plain language, with a help popover explaining the relay address field
- The desktop tray uses a dedicated, theme-aware monochrome icon

### Fixed
- Direct messages update live more smoothly
- Large member rosters stay responsive when opened
- The chat thread panel lays out correctly on medium-width windows
- Desktop: the app loads reliably at its root and no longer breaks Linux desktop integration

### Security
- The desktop login is encrypted at rest, and the desktop database file is readable only by its owner

## [0.46.5] - 2026-08-05

Pin a direct message to the rail beside your communities, so a conversation you're in all day is one tap away, and the conversation with yourself now reads as Note to Self. Armada installed to the Home Screen shows an unread badge on its icon while it's closed, keeps its background notifications alive when the browser's subscription expires, and says plainly when a device can't deliver them at all.

### Added
- Pin a direct message to the rail from the DM list's right-click menu; it drags, folders, reorders, syncs and carries an unread dot like any other rail item
- The conversation with yourself is shown as Note to Self across the DM list, thread header, recipient picker and composer
- Armada installed to the Home Screen shows an unread badge on its app icon, cleared when you open it

### Changed
- Notification settings say precisely why background notifications are unavailable — no push service configured, Lockdown Mode, or not installed to the Home Screen — and offer a retry when setup fails

### Fixed
- Background notifications repair an expired browser subscription when you return to Armada, instead of going quietly dead
- A conversation with messages in it no longer flashes a loading placeholder, and an empty thread still catching up says so rather than "No messages yet"

## [0.46.4] - 2026-08-05

Your own lists and settings — follow and mute lists, your servers and communities, and how they're arranged — now sync reliably: a change made on another device is already there when you open the app, and on Android they keep syncing while the app is closed. Reading stored messages on Android also does substantially less work, so the app stutters less.

### Changed
- Reading stored messages on Android does substantially less work, reducing stutter and unresponsiveness

### Fixed
- Your lists and settings show the current version when the app opens, rather than only changes that arrived while it happened to be running, and refresh after the app has been in the background a while
- On Android, your own lists and settings keep syncing while the app is closed
- Settings are no longer republished on the basis of an incomplete read

## [0.46.3] - 2026-08-05

Reply to a message straight from an Android notification, without opening the app — in servers, direct messages, and Concord communities. A quick reply honours the conversation's disappearing-message timer and appears in the notification thread under your own name and photo. Notifications for encrypted communities also keep arriving after a relay reconnects while the app is asleep.

### Added
- Reply to a message directly from an Android notification, without opening the app — in servers, direct messages, and Concord communities
- A quick reply honours the conversation's disappearing-message timer, and shows your own name and photo in the notification thread

### Fixed
- Notifications for encrypted communities keep arriving after a relay reconnects while the app is asleep

## [0.46.2] - 2026-08-04

Sharing into Armada from another app is smoother: the destination opens immediately instead of waiting for the shared file to finish copying, and a share that resolves slowly still lands in the right composer rather than nowhere.

### Changed
- A sender whose profile can't be resolved is named "Anonymous" in notifications, instead of a truncated key

### Fixed
- Sharing into Armada opens the destination right away, without a flash of the previous screen while the shared file copies
- A share that takes a while to resolve on a cold start now opens its composer instead of leaving the shared content stranded

## [0.46.1] - 2026-08-04

Pin messages in community channels — a pinned message is cryptographically verified against the original so its content cannot be falsified after the fact. In-app signup is now the full-screen key wizard, and channel history paints incrementally with a visible error when sync fails.

### Added
- Pin and unpin messages in a channel; a pin bar shows the channel's pinned messages with their images and attachments
- In-app signup uses the same full-screen key wizard as the main onboarding flow

### Changed
- Channel history paints incrementally, and surfaces a visible error when sync fails
- Startup sync skips communities and servers that already show an unread dot, reducing redundant work on open
- Disappearing-message countdown appears only on the date separator row, not on every message

### Fixed
- Pinned images open in the full image viewer instead of a raw file URL
- Messages that are still sending no longer show an encryption-error label

## [0.46.0] - 2026-08-04

Concord communities get disappearing messages: a community-wide timer, set at creation or in community settings, that expires messages for everyone and lets relays purge them too. Channels can be grouped into categories and dragged into order, new text channels default to private, and invite links are limited to owners and admins. Discover gains a theme creator and paints faster, and channels, threads, DMs and message links are all addressable by URL.

### Added
- Disappearing messages in Concord communities, with a notice in each channel when staff change the timer
- Channel categories: group channels, manage categories from the sidebar, and drag channels to reorder or file them
- A theme creator in Discover
- Revoke all of your own invite links for a community at once
- Add members to a private channel from the member sidebar
- A public chat link page for a person, so someone who isn't on Armada sees who they'd be talking to and can join
- Share an image straight from the lightbox

### Changed
- New text channels default to private, and a new community starts with a private room alongside #general
- Invite links can only be created by owners and admins, and warn that recipients keep permanent access to a public channel's history
- Channels, threads, DMs and message links are driven from the URL, so sharing, bookmarking and back/forward work on every chat surface; DM addresses moved from `/dms` to `/dm`
- Inviting someone is a single tap to share, and minting the link is faster
- Discover paints sooner, fetches its directory in one round trip, and ranks communities by owner
- The Discover share picker only offers communities that have a live invite link
- The landing page is a single statement over live relay lights, with a "Why?" reveal, an encrypted quiz, and a closing join screen
- Faster boots and lower memory use, from lazy key derivation, batched storage writes on Android, and fewer redundant renders

### Fixed
- Switching channels no longer flashes a stale channel or an empty sidebar while a community is still loading
- A share the user cancels is no longer treated as a failure
- Shared links and files carry the right preview details for the site that built them

## [0.45.0] - 2026-08-02

Concord communities gain roles and serious moderation: build a role hierarchy with colours and ranks, gate private channels behind roles, and work through a searchable Members tab with mass ban and kick. Onboarding is now a guided full-screen wizard with a real key-backup step, and a new landing page greets first-time visitors. Under the hood, local storage moves to ArmadaDB for faster boots and steadier sync.

### Added
- Community roles in Concord: create, rename, colour, drag to reorder, and revoke, with rank-based permissions
- Private channels gated behind roles
- A Members tab with a searchable, sortable member directory, range selection, and mass ban or kick
- Message permalinks, so notification taps land on the message itself
- Unpublish a community from Discover
- A post-login opt-in for web push, with guidance for iOS notifications
- Save lightbox images to the device; on iOS, saved downloads appear in the Files app

### Changed
- Onboarding is a full-screen wizard: strictly linear steps, a key step gated on a real backup, key export through a file dialog, and a landing on Discover
- A new landing page: a scrolling deck over an ASCII sea
- Consolidated app iconography and a reworked animated boot mark; the Android splash holds until the crest animation finishes
- Discover listings use community announcement events instead of mined kind-1 notes
- Local storage is rebuilt on ArmadaDB, shared with the Android notification service, for faster boots and lower memory use
- Sync runs through a topic scheduler with durable freshness stamps and priority lanes
- Voice messages record at a speech-tuned bitrate
- Bot discovery queries only the conversation and app relays

### Fixed
- Channels restore their last-open selection and last painted window, so switching no longer flashes empty
- Relay sockets reconnect when switching accounts
- A DM opens on its last page instead of jumping to the top of the thread
- Link previews no longer downgrade when a slower fold finishes late
- Non-relay URLs are rejected when opening the pool, and embed relay hints are sanitized
- Media-only notifications name the kind of media

### Removed
- The build-time platform relay pin and the legacy relay push gateway

## [0.44.1] - 2026-07-30

A maintenance release with no changes to the app itself. It restores automatic publishing to Google Play, delivering the 0.44.0 release — webxdc games in the composer, synced favorite GIFs, and curated Discover feeds — to Play Store users.

## [0.44.0] - 2026-07-29

Webxdc games can now be launched from the composer and played directly in Concord communities. GIF search defaults to GIFverse, with KLIPY available as an opt-in provider; favorite GIFs sync across devices. Discover feeds filter to curated content by default, with a setting to show everything. Several fixes improve DM push notification reliability across focus and mute edge cases.

### Added
- Webxdc game picker in the composer for launching games directly in Concord communities
- Webxdc apps run in Concord v2 channels
- Favorite GIFs sync across devices
- Images can be pasted from the clipboard anywhere in the composer
- KLIPY as an opt-in alternative GIF provider
- A setting to show all Discover content, bypassing the curated allow-list

### Changed
- GIF search defaults to GIFverse; KLIPY is available as an opt-in alternative
- Discover feeds are filtered to a curated author allow-list by default

### Fixed
- DM push notifications now deliver when the app is not in focus; duplicates and self-sent notifications are suppressed
- Focused community notifications are suppressed
- Muted DM conversations hide immediately
- DM loading and chat attachment handling hardened
- Encrypted .xdc attachments are decrypted before unzipping

## [0.43.0] - 2026-07-29

Non-media file attachments in chat appear as download cards. On-device messages are now searchable from the quick switcher. Edited Concord messages show an (edited) label. An iOS build is available for sideloading. Several Concord fixes enforce dissolved-community lockout and close gaps in moderation authority validation.

### Added
- Non-media file attachments in chat appear as download cards
- On-device messages are searchable in the quick switcher
- Edited messages in Concord communities are marked (edited)
- An iOS build is now available

### Fixed
- Dissolved communities can no longer receive writes or subscriptions
- Community moderation actions require a verified authority citation, closing a delegation gap
- File attachment card is not shown twice when its URL also appears inline in the message

## [0.42.2] - 2026-07-28

Onboarding is redesigned as guided setup wizards. Calendar events appear as inline cards in chat, GIF previews load as video, and Concord communities surface in the quick switcher. Several fixes improve DM delivery on relays that require authentication, mention jump scrolling, and Concord community integrity.

### Added
- Calendar events render as inline cards in the chat timeline
- A bridge indicator on messages relayed from other platforms
- Concord communities and channels appear in the quick switcher
- A warning for community admins when an action is attempted without sufficient permission

### Changed
- Onboarding and post-login prompts are redesigned as step-by-step setup wizards
- GIF picker previews load as video instead of full-size images
- GIF picker thumbnails are inert until selected
- The member list show/hide preference is saved across sessions

### Fixed
- DM messages are fetched per relay so relays that require authentication are no longer skipped
- Mention jumps scroll to the correct message again
- The reaction button stays as the touch target during long-press
- Retrying a community key rotation resumes the existing rotation instead of forking the community
- Several Concord community control and integrity fixes
- Direct invites are scoped to the correct recipient

## [0.42.1] - 2026-07-27

Unknown-sender direct messages are now held in a separate request tier — visible but quiet, with no avatar loaded until you reply. Community discover cards show when you're already a member. The relay settings section gains descriptions and new toggles for which relay pools the app uses. Creating a community shows which relays it will live on before you submit. The first emoji pack you add no longer fails.

### Added
- DM requests: messages from unknown senders appear in a separate tier, with no avatar loaded (to avoid confirming receipt to the sender) and a shared community shown when one is known
- A block action on request conversations, available from the right-click or long-press menu
- A settings toggle to hide the DM request tier entirely
- Community discover cards show a "Joined — Open" button when you're already a member

### Changed
- Creating a community shows which relays it will live on before you submit
- The relay settings section has descriptions for each relay type and new toggles to control which pools the app uses
- The servers settings section has a description explaining what NIP-29 servers are

### Fixed
- Adding the first emoji pack no longer fails

## [0.42.0] - 2026-07-26

Ecash tokens pasted into chat now render as a card showing the amount, with the mint and the raw token a tap away, and the card asks the mint whether the token has already been redeemed. Typing indicators work with browser extensions and remote signers and are on by default. Thread replies gain the same reaction row and action menu as timeline messages. Servers you remove stay removed, and leaving a community clears its slot in the sidebar for good.

### Added
- Ecash tokens in chat render as a card with the amount, a copy button, and the mint and raw token in a popover
- Ecash cards check with the mint and mark a token that has already been redeemed
- The frequent-reaction quick row and the full message action menu on thread replies

### Changed
- Typing indicators in direct messages work with browser extensions and remote signers, and are enabled by default
- The message edit box grows to fit its wrapped content
- Messages sent in a community show as sent immediately instead of holding a spinner until every relay answers
- Channels open faster
- Visiting a server link no longer adds that server to the sidebar; a server is added by joining a channel or adding it explicitly

### Fixed
- Removed servers no longer reappear from a device holding an older copy of the list
- Leaving, declining, or being removed from a community clears its sidebar slot, so rejoining no longer lands back in the old folder
- Dialogs stay clear of the Android status bar, keeping the close button reachable
- A trailing parenthesis stays with a link when the URL's own parentheses are balanced
- The message toolbar is no longer clipped at the top of the thread panel
- Joining or leaving a community no longer fails when the community's own relays reject the update

## [0.41.0] - 2026-07-25

Direct messages gain disappearing messages: either person sets a timer for the conversation, and expiring messages carry an animated countdown clock that empties as the deadline approaches. Typing indicators arrive as an opt-in setting, and conversations can be pinned to the top of the message list. Android notifications now clear when you read a conversation in the app or on another device.

### Added
- Disappearing messages in direct messages, with a shared per-conversation timer either person can set
- An animated countdown clock beside expiring messages, spelling out the remaining time in the final hour
- Typing indicators in direct messages, off by default and enabled in Settings (unavailable when signing with a browser extension or remote signer)
- Pinned conversations in the direct message list, pinned by right-click or long-press and synced across devices

### Changed
- The quick switcher lists servers in the same order as the sidebar rail
- Single-emoji messages render a step larger, with room so they aren't cropped
- The reaction picker drawer sizes itself to the picker
- Project cards, stat pills, and the emoji pack remove button lose their borders
- The ticket comment composer matches the composer used elsewhere in the app

### Fixed
- Android notifications for a conversation clear when it is read in the app or on another device
- Enter no longer sends a message while confirming an in-progress composition in Chinese, Japanese, Korean, and other multi-keystroke input methods
- The Bitcoin wallet stops contacting a third-party service while the wallet dialog is closed

## [0.40.0] - 2026-07-25

Communities gain a Projects workspace for tracking work items: browse issues, pull requests, and comments from connected repositories, filter by status and labels, and edit items directly in Armada. Repositories attach to channels, integrate their git activity into the chat timeline, and sync updates live. Image attachments open in a cinematic lightbox, custom emoji rendering is polished across the app, and message actions are redesigned into a touch-friendly sheet on mobile and a desktop menu.

### Added
- Projects workspace for tracking issues, pull requests, and comments from git repositories
- Repository attachment to channels with live git activity timeline integration
- File attachments to issues, pull requests, and comments with markdown rendering
- Issue creation and status editing directly from the Projects view
- Labels for work items with filtering and assignment from a repository's vocabulary
- Image attachment lightbox with swipe navigation, zoom, and download
- ngit-ci workflow runs rendered in channel git activity timelines
- Custom emoji rendering in display names and message content

### Changed
- Message actions (react, reply, zap, thread) restyled into a touch-friendly sheet on mobile and a desktop overflow menu
- Emoji pack restyling with improved pack metadata display
- Link preview proxy endpoint now configurable

### Fixed
- Swipe-to-reply is suppressed while a lightbox is open
- Read state publishes only when settings base is available
- Quick reaction table syncs reliably through encrypted settings
- Attached video is compressed and extracts NIP-94 metadata on upload

## [0.39.10] - 2026-07-24

Custom emojis now render in people's names and in message previews, emoji packs carry a name and cover image with a rebuilt creation flow, and your emoji palette sticks around between reloads. The direct message list opens instantly in its final order with wider, larger rows, and a batch of chat scrolling and reaction glitches are fixed. Servers you remove now stay removed.

### Added
- Custom emojis render in display names across chat, member lists, mentions, direct messages, and profiles
- Custom emojis render in direct message conversation previews
- Emoji packs carry a name, description, and cover image
- Emoji pack creation takes drag-and-dropped images, flags blank and duplicate shortcodes before publishing, and can add the pack to your own emojis

### Changed
- Restyled Discover with the floating command bar, tab pills, and a search field used elsewhere in the app
- Wider direct message conversation list with larger rows and avatars
- The direct message list restores instantly in its final order instead of reshuffling as it loads
- Chat loading placeholders fill the pane and vary per row instead of reading as a progress bar
- The direct message composer is focused when a conversation opens on desktop

### Fixed
- Your custom emoji palette no longer empties after a reload
- Reactions no longer vanish and reappear after you react
- Sending a direct message no longer makes the message flicker or lose your place in the conversation
- Conversations no longer come to rest above the newest message
- Servers you removed no longer reappear after a reload or from another device's outdated data

## [0.39.9] - 2026-07-24

Adds a Discover page for browsing public communities, emoji packs, and themes. Communities are found by mining invite notes shared on app relays, so there's no central listing to maintain. You can also create and share emoji packs and themes directly from the Discover page.

### Added
- Discover page for browsing public communities, emoji packs, and themes
- Community discovery by scanning shared invite notes on app relays
- Create and publish custom emoji packs from the Discover page
- Save and share custom themes from the Discover page

## [0.39.8] - 2026-07-24

Reworks how chat is rendered. Channels open and switch without the pause that used to come with a long timeline, scrolling back through history keeps your place, and jumping to a message lands on it in one step.

### Changed
- Opening or switching a channel renders progressively, so the tap responds right away instead of waiting on the whole timeline
- Scrolling toward the top reveals older messages in place, and loading more history no longer shifts what you were reading
- Returning to the newest message restores your distance from it instead of snapping to the bottom
- Jumping to a message centers it immediately rather than drifting into place over a couple of seconds
- Redrawn Android notification icon using the simplified Armada A

### Fixed
- Link previews no longer leave blank space under one-line titles or links with no author
- Chat media and link previews reserve their space as they load, so the timeline stops jumping around

## [0.39.7] - 2026-07-24

Fixes signing in with an external Android signer app, such as Amber, on relays that require authentication.

### Fixed
- Relays that require authentication now work when signed in with an external Android signer app

## [0.39.6] - 2026-07-24

Fixes the background mesh connection on Android 14 and newer, where it could crash and repeatedly restart shortly after starting.

### Fixed
- Mesh background service no longer crashes and restarts on Android 14+

## [0.39.5] - 2026-07-23

No user-facing changes — this release publishes Armada to Google Play for the first time and is otherwise the same app as 0.39.1.

## [0.39.4] - 2026-07-23

No user-facing changes — the same app as 0.39.1; superseded by 0.39.5.

## [0.39.3] - 2026-07-23

No user-facing changes — superseded by 0.39.4 before anything was published.

## [0.39.2] - 2026-07-23

No user-facing changes — superseded by 0.39.4 before anything was published.

## [0.39.1] - 2026-07-23

Read state for Concord channels, mentions, and threads now syncs across your devices instead of living only on the one you read on, and there's a quick "mark all as read" action for servers, direct messages, and communities.

### Added
- "Mark all as read" action in server, direct message, and Concord community menus
- A check-check button in the Messages list header to mark every unread conversation read

### Changed
- Concord channel, mentions, and threads read state syncs across devices through your shared encrypted settings
- Which channel you're viewing no longer syncs across devices — it stays per device, so two open clients stop switching each other's channel

### Fixed
- Preview cards for shared links use absolute image URLs and include the page URL and site name

## [0.39.0] - 2026-07-23

Adds a key backup section to Settings and a much richer set of Android message notifications, grouped by community with a Mark read action and per-conversation avatars. The Android app also moves to a new identifier (buzz.armada.app), so it installs alongside an existing Armada install with fresh data — back up your key first, and sign in again after updating.

### Added
- Key backup section in Settings for saving and restoring your account key
- Banner images for channels on relay-based servers, set by admins in channel settings
- Share a channel with a standard Nostr link that other clients understand, and paste one in to join

### Changed
- The Android and desktop app identifier is now `buzz.armada.app`. On Android this installs as a separate app with its own data, so sign in again with your key backup; future updates come from the new listing
- Android message notifications are grouped by community, show conversation avatars, post each channel and direct message separately, and offer a Mark read action
- Your login is stored in the device's secure storage on mobile
- Pinned messages on relay-based servers use the standard pinning format; the server must support it, and pins set with the previous format are no longer shown

### Fixed
- Background notifications verify every message's signature and discard anything that wasn't requested
- Joining a relay-based server no longer fails when the server's info can't be fetched
- Notification text resolves mentions to names and no longer shows raw media links

## [0.38.0] - 2026-07-22

Adds community-wide message search to Concord communities — search every channel by keyword with channel, author, and media-type filters. Also tidies the channel header and server rail, and makes Android background notifications more reliable.

### Added
- Search across a whole Concord community by keyword, with channel, author, and media-type (images, videos, links) filters

### Changed
- Channel header actions, including invite and mute, now live in an overflow (…) menu on both mobile and desktop
- Server rail pins Settings to a fixed footer and hides horizontal scroll overflow

### Fixed
- Android background notification service stays alive more reliably
- Reserve the mobile call bar height so the swipe-reveal underlay lines up

## [0.37.1] - 2026-07-22

Buzz community invite links now open directly in the Armada app, and several fixes protect your saved servers, DM relays, and mute list from being accidentally overwritten when they can't be loaded.

### Changed
- Buzz community invite links now open directly in the app instead of a web page

### Fixed
- Protect your saved servers, DM relays, and mute list from being lost if the list fails to load before a change is saved

## [0.37.0] - 2026-07-21

Adds support for Buzz communities — a richer relay-based mode with forum-style discussions shown as cards and a dedicated Projects workspace with a contribution graph. Also adds a per-server Inbox that collects your mentions and opens each thread inline, clickable profile mentions, and member roles in the member list.

### Added
- Buzz community support: connect to Buzz relays with forum posts and comments rendered as card-style discussions
- Projects workspace for Buzz communities, with a tabbed layout and a contribution graph
- Per-server Inbox of your mentions, shown above Projects in the channel sidebar; opening a mention shows its thread inline
- Member roles shown in the member list
- Clickable @name mentions that open the person's profile popover
- Right-click a server to remove it
- Copy-ID button on embedded posts
- View event JSON option on messages

### Changed
- Server actions are now available from the channel-sidebar header menu on mobile

## [0.36.1] - 2026-07-21

Adds a relay picker to the community creation flow (pre-seeded with sensible defaults) and tightens invite controls: public invite links now require the CREATE_INVITE permission and direct invites are capped at 3 days.

### Added
- Relay picker in the create-community flow, pre-seeded with app relays and expandable inline

### Changed
- Public invite links now require the CREATE_INVITE permission
- Direct invites are capped at a 3-day expiry

## [0.36.0] - 2026-07-21

Adds emoji reactions and raise-hand gestures to voice calls, a floating in-call video window for browsing other channels during a call, a resizable compact mobile call preview, push notifications for direct messages, and active-speaker video highlighting. DM relay settings are now managed independently.

### Added
- Emoji reactions and raise-hand in Concord voice calls, visible in the video pane
- Floating in-app video window so you can browse other channels during an active call
- Screen-share control in the floating call window
- Compact mobile call preview above the call bar, draggable and resizable with a corner grip
- Active-speaker ring highlight on camera video tiles
- Push notifications for direct messages
- Default DM relay fallback so DM delivery works without a configured relay list

### Changed
- Call controls unified across views; raise-hand split into its own button; stage auto-opens when video is active
- Video pane and sidebar are now resizable
- DM relay settings managed independently with their own toggles
- DM conversations with sent or received messages stay listed across sessions (with durable storage requested)

### Fixed
- Show the avatar when a video track is muted instead of a blank tile
- Retry failed avatar loads and upgrade HTTP picture URLs to HTTPS
- Suppress DM notifications while the conversation with that person is open
- Fix screen-share switching reverting or detaching video in the floating window
- Fix brace-expansion security vulnerability in dependencies

## [0.35.3] - 2026-07-20

Fixes crashes that could send the app to the error screen immediately after updating, and improves the crash screen to show the error message.

### Fixed
- Fix crashes to the error screen on first open after a release (stale cached app shell and a router link in the update toast)
- Show the error message on the crash screen so issues can be reported from a phone

## [0.35.2] - 2026-07-20

Fixes the first tap after an edge swipe being silently ignored.

### Fixed
- Fix first tap after an edge swipe doing nothing (swipe was entering the browser scroll pipeline and suppressing the next tap)

## [0.35.1] - 2026-07-20

Swipe-to-reply now uses a leftward swipe.

### Changed
- Swipe left on a message to reply (was swipe right)

## [0.35.0] - 2026-07-20

Chat and thread panels now use virtual scrolling for smooth performance with long histories. Voice calls now stay in sync with the live community state: the app automatically rejoins the room when the channel is rekeyed, and hangs up when you are banned or removed.

### Added
- Voice calls automatically rejoin the room when the channel is rekeyed or refounded
- Voice calls hang up automatically when you are banned or removed from a community

### Changed
- Chat timeline and thread panel use virtual scrolling for smooth performance with long message histories

## [0.34.0] - 2026-07-19

Adds swipe-to-reply on messages, a favorite GIFs tab, and a default payment method setting for zaps. Thread panels now have a jump-to-latest button, auto-scroll when opened, and a fullscreen expand toggle on desktop. Several community moderation and invite delivery edge cases are also fixed.

### Added
- Swipe right on a message to reply to it
- Favorite GIFs tab that persists your saved GIFs across sessions
- Default payment method setting for zaps in Wallet settings
- Thread panel: jump-to-latest button and auto-scroll when opening a thread
- Thread panel: fullscreen expand/collapse toggle on desktop

### Fixed
- Message action toolbar (react, reply, zap) no longer hidden behind the message above it
- Editing messages from within a thread panel now works
- Touch targets audited and corrected across the app
- Members who joined before the ban that removed them are no longer incorrectly counted
- Invites are now delivered to members who have no relay list configured
- A rejoining member's stale ban list is correctly healed on re-entry

## [0.33.0] - 2026-07-18

Community moderation is significantly improved. Admins now see a dedicated ban dialog with a progress indicator that walks through key rotation, locking the banned member out of encrypted history. Banned members see a clear "you've been banned" screen and are silently removed from the community. The client also refuses to join communities that have banned you. Communities are now classified as Public or Private based on their membership settings.

### Added
- Ban dialog with step-by-step progress for admins banning a member
- Banned view shown to members who have been removed from a community
- Communities are now classified as Public or Private based on their membership settings
- Banned users are silently self-removed from communities that list them (honest-client compliance)
- Client refuses to join a community that has banned you

### Fixed
- Banning a member now correctly rotates encryption keys to prevent re-entry
- Fixed a re-admission loop where a banned user could rejoin after leaving

## [0.32.2] - 2026-07-18

Adds optional Plausible Analytics support for hosted deployments. Analytics is disabled in the Android APK, Electron desktop app, and local dev builds — it only activates when a hosting operator sets `VITE_PLAUSIBLE_DOMAIN` at build time.

### Added
- Optional Plausible Analytics for hosted deployments (cookieless, off by default in APK/desktop/dev builds)

## [0.32.1] - 2026-07-18

Polishes the chat message action menu. The react/zap/reply/thread toolbar no
longer gets clipped by the message above it and now reveals reliably on tap,
and the reply and thread icons have been swapped to match conventional
messaging apps.

### Changed
- Swapped the reply and thread icons to match conventional messaging UX

### Fixed
- The message action menu (react, zap, reply, thread) is no longer clipped at the top by the message above it, and now appears reliably when you tap a message

## [0.32.0] - 2026-07-18

Android users can now log in with a native signer app (Amber or any NIP-55
compatible signer) directly from the login screen — no relay round-trip
required. Remote signing over NIP-46 has been fully reworked for better
reliability and a smoother pairing flow, and users without a signer get a
gentle nudge to set one up. Under the hood, the event cache has moved from
IndexedDB to SQLite, which is now shared with the Android notification service
so notification content stays accurate without redundant fetches. Notifications
also persist sender avatars to disk, stay active when the app is backgrounded,
and show a large-icon fallback. Several Android polish fixes land too: startup
keyboard lag is reduced, the back button correctly minimizes the app from the
root screen, and link embeds are sandboxed.

### Added
- Log in with a native Android signer app (Amber or any NIP-55 compatible signer) directly from the login screen
- Signer nudge prompts users without a proper signer configured to set one up

### Changed
- Remote signing (NIP-46) has been reworked for improved reliability and a smoother pairing UX
- Replaced the IndexedDB event cache with a SQLite store shared with the Android notification service
- Android push notifications persist sender avatars to disk and show a large-icon fallback when no avatar is cached
- Push notifications stay active when the app is backgrounded (Electron tray keep-alive and browser tab refocus)
- Encrypted media object URLs are revoked after use and the in-memory cache is bounded to prevent unbounded growth
- Link embeds (Spotify etc.) run in a sandboxed iframe

### Fixed
- Reduced startup keyboard lag on Android
- The back button now correctly minimizes the app when pressed at the root screen on Android
- Custom emoji images fetched from loopback or private-network addresses are blocked
- Removed servers no longer reappear after deletion due to relay-based server-list sync

## [0.31.2] - 2026-07-17

Re-publishes the v0.31.1 update to Zapstore. The previous release built and
uploaded correctly but never appeared in the listing because every ngit-ci
build was stamping the same Android version code, so the store treated it as
a duplicate. This release fixes the version-code derivation and re-publishes.

## [0.31.1] - 2026-07-17

A quiet round of mobile ergonomics and reliability fixes. Touch targets
across the chat are bigger and easier to hit on phones, the composer no longer
shows a stray wrapped line when the placeholder is long, and removed servers
stay removed instead of sneaking back in via relay sync. Push notifications on
Android also now keep their sender-profile cache across restarts, so
notification content stays accurate.

### Changed
- Enlarged touch targets across the chat UI for better mobile ergonomics

### Fixed
- Removed servers no longer reappear after they are deleted, fixing a regression
  caused by relay-based server-list sync
- The composer no longer shows a stray wrapped line or misaligned placeholder on
  mobile
- Android push notifications keep their sender-profile cache across restarts, so
  notification content stays accurate

## [0.31.0] - 2026-07-16

Community admins can now edit which relays a community lives on. Change the
relay list from the community info dialog and every member follows the move
automatically — their apps re-point without anyone lifting a finger. When you
add a relay, the community's history is copied to it first, so newly added
relays come online already carrying the backlog. Guardrails keep the switch
safe: relay addresses are normalized and de-duplicated, at least one relay is
always kept, and a swap that shares no relays with the current list asks for
confirmation before it can strand offline members.

### Added
- Community admins can edit a community's relay list; members' apps follow the
  change automatically, and a newly added relay is seeded with the community's
  history so it comes online with the full backlog

## [0.30.1] - 2026-07-16

Polish for community admins and a quieter sync experience. Invite-link
management now shows which key epoch each of your links serves, warns when a
link has fallen behind after a rekey, and lets you inspect a link's stored
record (with secrets redacted). The invite-links, member-health, and audit-log
admin views now open on mobile too. And the old full-width "Syncing…" bar is
gone, replaced by an unobtrusive spinning dot in the corner of the channel icon
that you can tap for details.

### Added
- Invite links now show the key epoch they serve, nudge you when a link has
  fallen behind after a community rekey, and offer a details view of the link's
  stored record (secrets redacted)

### Changed
- The invite-links, member-health, and audit-log admin views now open on mobile
- Replaced the full-width "Syncing…" bar with a passive spinning dot on the
  channel icon; tap it for what's syncing

## [0.30.0] - 2026-07-16

Bot commands come to Armada. Communities and DMs can now surface bot commands
through a `/` picker in the composer, with guided argument entry — including
pickers that rank suggestions by recent channel activity. Voice calls are also
friendlier: you now join muted and opt in with the mic button, so you're never
broadcasting the instant you connect. Plus, the app now recovers automatically
from the blank-screen crash that could happen right after a new version was
deployed.

### Added
- Bot commands: type `/` in a community channel or direct message to discover
  and run a bot's commands, with guided prompts for each argument

### Changed
- Voice calls now start muted; tap the mic button to speak

### Fixed
- Automatically recover from a blank-screen crash that could occur the first
  time you loaded the app after a new version was deployed

## [0.29.0] - 2026-07-16

New admin tools for Concord communities. Community admins get an audit log of
control-plane changes, an invite-links view for managing shared links, and a
member-health view. Members whose keys fell behind after a key rotation are now
detected and healed automatically instead of being silently locked out, and
custom emoji reactions render cleanly even when their image can't load.

### Added
- Community admin views for Concord: a control-plane audit log, an invite-links
  manager, and a member-health overview

### Fixed
- Members left behind by a community key rotation are now detected and recover
  automatically instead of being stranded without access
- Custom emoji reactions always show a safe glyph and count instead of a long
  raw URL when the emoji image fails to load

## [0.28.4] - 2026-07-16

A small fix for menus on narrow screens. Submenus opened from a message or
conversation menu — such as the Encryption and Notifications options — no longer
run off the edge of the screen, so their choices stay fully visible and tappable.

### Fixed
- Nested menus (like the DM Encryption and Notifications submenus) no longer
  overflow off the side of the screen on narrow displays

## [0.28.3] - 2026-07-16

A direct-message and community-security release. Each DM conversation now has an
Encryption option so you can choose automatic, always-private, or legacy
encryption for that person. Behind the scenes, community key rotation is more
robust: invite links stay valid after a rotation instead of stranding new
joiners, revoked links can't come back from a stale device, and members removed
during a rotation properly lose access to private channels.

### Added
- Per-conversation DM encryption picker: choose Automatic, Private, or Legacy
  encryption for each person you message

### Fixed
- Invite links keep working after a community key rotation instead of leaving
  new members unable to join
- A revoked invite link can no longer be resurrected by an out-of-date device
- Members removed during a key rotation now correctly lose access to private
  channels

## [0.28.2] - 2026-07-15

A direct-message polish release. You can now react to and quote DMs on mobile by
tapping a message to reveal its action toolbar, and the conversation-list header
gets larger, easier-to-tap search and new-message buttons that match the rest of
the DM interface.

### Added
- Tap a direct message on mobile to reveal its action toolbar for reacting,
  quoting, and more

### Changed
- Larger, easier-to-tap search and new-message buttons in the DM conversation
  list, matching the conversation top bar

## [0.28.1] - 2026-07-15

A messaging and reliability release. Private DMs now arrive the instant they're
sent, with notifications firing right away instead of waiting on a slow refresh.
Invite links and emoji packs shared in chat now render as rich, tappable cards
you can join or add with one tap. Voice calls keep running when you switch away
from the app on Android, and several cases where a Concord community could
briefly vanish from your sidebar — or where the app needed a restart to recover
— are fixed.

### Added
- Invite links posted in chat render as a join card showing the community name,
  icon, and channel count, with a one-tap Join/Open button
- Emoji packs shared in chat render as a preview grid with an Add button that
  adds the pack to your emoji list

### Changed
- Tearing down a Concord community now uses clearer "dissolve" wording

### Fixed
- Private direct messages now arrive live the moment they're sent, and their
  notifications fire right away instead of waiting for a periodic refresh
- Voice calls stay connected when you switch away from the app on Android
- A Concord community no longer briefly vanishes from your sidebar after joining
  via an older invite, or after a kick/ban
- The app now recovers on its own from a stuck connection that previously needed
  a restart
- Onboarding is no longer forced when relaunching the app — only when creating a
  new account
- Fixed an intermittent crash when refreshing the app right after an update

## [0.28.0] - 2026-07-15

A private direct messages release. Armada now sends and receives fully
encrypted, metadata-hiding DMs — including images and files — and raises
notifications for incoming messages on both desktop and Android. You can search
your whole DM history and jump straight to matching messages. When a person
hasn't set up private messaging, Armada tells you plainly and lets you choose
whether to fall back to older, less-private encryption rather than silently
downgrading. Profile hovercards now pick up each person's own color theme, and
desktop voice tells you how to fix a microphone that's blocked by your OS.

### Added
- Private direct messages: fully encrypted DMs that hide who you're talking to,
  with support for sending images and files
- Notifications for incoming DMs while the app is running, plus Android
  background notifications for new DMs
- Notifications when someone reacts to your message in a Concord community
- Search across your full DM history, with matching text highlighted and a
  tap-to-jump list

### Changed
- When a recipient hasn't enabled private messaging, Armada now explains the
  situation and asks you to explicitly opt in to legacy encryption instead of
  quietly using the less-private format; the privacy badge is now tap-to-open
  with plain-language detail
- DM headers are decluttered: search and options moved into an overflow menu,
  with a padlock badge on the avatar
- Profile hovercards are tinted with the person's own color theme

### Fixed
- "Skip for now" on the welcome screen is remembered, so onboarding isn't forced
  on every relaunch
- Desktop voice now guides you to the OS privacy setting when the microphone is
  blocked at the system level, instead of just failing
- Profile cards no longer briefly flip to an older version of someone's profile

## [0.27.3] - 2026-07-14

A notifications release. Armada now raises real notifications for incoming
messages, mentions, and DMs while it's running, and you can set a Discord-style
notification level per conversation — all messages, mentions only, or nothing.
This release also steadies live message delivery over long sessions, adds a
single consent prompt before decrypting a backlog of DMs on bunker/extension
signers, shows now-playing music status on profiles, and fixes a handful of
Concord community edge cases.

### Added
- Notifications for incoming messages, mentions, and DMs while the app is open
- Per-conversation notification levels — choose all messages, mentions only, or
  nothing for each channel and DM
- Now-playing music status shown on profiles and member lists

### Changed
- Opening DMs with a bunker or extension signer now asks once before decrypting
  a large backlog, instead of firing a decrypt request per message

### Fixed
- Live messages now keep streaming into the open channel over long sessions
  instead of silently stalling until a relaunch
- Newly-added Concord channels now appear right away instead of waiting for a
  first message
- Member-only channels are recovered for users migrating from Flotilla
- A Concord community is brought back when a rekey re-includes a previously
  excluded member
- A dissolved Concord community is now read-only and can be removed manually
- Joining a call with video auto-expands the call stage, with a clearer stage
  toggle; paused stage videos resume when moved back into a page slot

## [0.27.2] - 2026-07-13

A permissions and enforcement release for Concord communities. Banned
members can no longer keep editing community metadata, channels, or grants
after being removed; only members with the proper rank can revoke or demote
others (previously any member could strip anyone's role); a dissolved
community can't be refounded out from under its owner; and the per-plane
read rules and metadata size limits are now applied on read, not just on
write.

### Fixed
- Banned members' events are now dropped everywhere in a community, not
  just in chat — previously a banned member could still edit community
  metadata, channels, grants, or the guestbook, and could even rekey the
  community out from under everyone
- A community's owner dissolution now wins every race: the app no longer
  adopts a rekey epoch past the owner's dissolution, and a dissolved
  community can't be rotated
- Only members who actually outrank a role can revoke or demote it —
  previously any member could strip anyone's rank because the authority
  check passed vacuously for empty (revoke) grant editions, and a
  lower-ranked role manager could demote a grant above its station
- A moderation action that the signer lacks the authority for is now
  pre-checked before publishing, so a kick/ban-only holder no longer
  publishes a doomed grant edition
- Control-plane editions are now required to be plaintext on read and
  chat/guestbook/rekey editions encrypted on read, matching the per-plane
  seal rules; an encrypted control edition used to fold and then silently
  vanish at the next compaction
- Community and channel name (64-byte) and description (10000-byte) limits
  are now enforced when folding metadata and channel editions, not just
  when writing

## [0.27.1] - 2026-07-13

A reliability and messaging release. Sending a message in an encrypted
community now shows it immediately with a pending badge instead of swallowing
it when remote signing is slow or fails, and signing in with a remote signer
(such as Amber) no longer dies silently on Android. Login now decrypts your
recent channel history before opening — no more empty rooms while catch-up
runs — with a slim in-chat status bar that names what's still catching up.
Plus fixes for private zaps that silently failed to seal, on-chain zaps
missing in self-hosted rooms, and initial sync overwriting your settings.

### Added
- A slim in-chat sync status bar names the background catch-up in flight
  ("Syncing #general — 84 messages") and hides once the channel is caught up

### Changed
- After login, the app now decrypts your recent channel history before
  opening, so rooms are populated instead of empty while catch-up finishes

### Fixed
- Messages you send in encrypted communities now appear immediately with a
  pending badge instead of vanishing when remote signing is slow or fails; a
  failed send shows a retryable state and a "Message not sent" notice rather
  than disappearing silently
- Signing in with a remote signer (such as Amber) no longer dies silently on
  Android, and lost signer responses recover in seconds instead of hanging
  forever
- The app no longer goes blank until you restart it when a background sync
  step silently wedges; stuck history pulls and dead live updates now
  self-recover
- Initial sync no longer overwrites your synced settings across relays and
  devices when the settings read comes back empty
- Private zaps in encrypted communities now reliably seal and appear for
  everyone, even when the wallet's payment acknowledgement is slow or lost,
  and private zaps again require a connected wallet
- On-chain Bitcoin zaps now appear under the reactions row in self-hosted
  server rooms, not just in Concord communities

## [0.27.0] - 2026-07-12

Armada can now send Bitcoin to other users: Lightning zaps from a wallet you
connect in Settings, plus on-chain payments whose attribution is sealed
privately into the channel tally. Messages in Concord communities can be edited after sending. Bot
accounts show a Bot badge next to their name wherever you see them. Tapping a
thread-reply notification now opens the thread directly, and the app lands on
your actual first community after login instead of a server you didn't pick.
Plus reaction removal, safe-area padding, and Android back-gesture fixes round
out the release.

### Added
- Send Lightning zaps to other users, publicly in servers and privately in
  Concord communities, from a Lightning wallet you connect in Settings
- Send on-chain Bitcoin payments, with the zap attribution sealed privately
  into the channel tally
- Edit your own messages in Concord communities after sending
- Wallet settings to connect and manage Lightning wallets and configure Bitcoin
  payment options
- Bot accounts show a Bot badge next to their name in chat, the member list,
  profile cards, mentions, and DMs
- Your custom emoji list now syncs across your devices

### Changed
- Tapping a thread-reply notification opens the thread panel directly, instead
  of just the channel
- After login, the app lands on the first item in your arranged community rail
  — not always the first server
- Opening a server's home page no longer auto-redirects into a channel

### Fixed
- Tapping a reaction you already added removes it instead of doing nothing
- Notifications for the channel or thread you're currently viewing are now
  suppressed
- Thread unread highlights clear when you open the thread from the chat timeline
- Image lightboxes close on the Android back gesture instead of navigating away
- Content in mentions, threads, DMs, and settings no longer scrolls under the
  home indicator or nav bar
- Replies whose original message isn't loaded are reachable from the Threads tab
  instead of cluttering the timeline
- Relay authentication no longer drops mid-session when a relay throttles a
  challenge or closes a subscription, which could stall live updates on desktop
  and web until restart

## [0.26.0] - 2026-07-11

Your account now stays in sync across devices automatically — joins, mutes,
follows, and settings made on one device reach the others without a manual
refetch. You can now delete your account right from Settings, with a guided
checklist of what gets removed from the network. A built-in changelog page
replaces the old "what's new" guesswork: a toast lets you know when an update
landed and links to the full release notes, now browsable in-app. Privacy
Policy and Terms of Service pages are reachable from the settings footer.
Several smaller fixes round out the release: the swipe-to-reveal gesture is
consistent again, thread state no longer leaks when switching between Concord
communities, and message context menus flip upward instead of dropping into
the composer.

### Added
- Cross-device sync: your follow list, mute list, server and channel
  memberships, Concord communities, relay lists, and app settings now stay
  continuously in sync across all your devices
- Delete account from Settings, with a guided checklist of what gets removed
- In-app changelog page with full release notes, linked from the Settings
  version footer
- Toast notification when a new version is available
- Privacy Policy and Terms of Service pages, linked from the Settings footer

### Fixed
- Swipe-to-reveal gesture is consistent across all list rows again
- Thread panel state no longer leaks when switching between Concord communities
- Message context menus flip upward instead of dropping into the composer
- Concord communities now populate correctly on a fresh login
- Back button on Settings sub-pages (changelog, terms, privacy) no longer
  loops back to the page you came from

## [0.25.4] - 2026-07-10

Every channel can now host a call — the text/voice split is gone, so you start
or join a call right from a channel's list row or its chat header. The Mentions
and Threads tabs now clear their unread badges the moment you open them, no more
per-item chasing. Bluetooth mesh got steadier on Android: your mesh identity
survives a device restore, and turning mesh off and back on no longer leaves it
stuck. Rounding it out are fixes for overflowing quoted text on narrow screens,
an attachment preview that appears the instant you pick a file, and big
behind-the-scenes speedups that cut battery and CPU use during long sessions.

### Changed
- Every channel is now callable: the separate text/voice channel types are gone,
  and you start or join a call from the channel's list row or chat header
- Opening the Mentions or Threads tab now marks everything in it as read

### Fixed
- Bluetooth mesh: your mesh identity is now restored after an Android backup
  restore, and toggling mesh off then on no longer leaves it unable to restart
- Long quoted text in replies and embedded notes no longer overflows on narrow
  screens
- The attachment preview now shows immediately when you pick a file, instead of
  only after it finishes processing
- Tooltips on the server rail no longer stick on touch devices
- Faster and lighter during long sessions: heavy encryption work is now cached
  and scoped per community, reducing background CPU and battery drain

## [0.25.3] - 2026-07-09

A quieter, more respectful release: removing a relay in Settings now actually
disconnects it instead of silently reconnecting to a built-in one, and the app
does far less needless background polling — no more constant refetching of
member statuses or duplicate catch-up requests on idle channels, and polls now
pause entirely while the app is in the background. That means less battery and
data use when you're not actively chatting.

### Changed
- Greatly reduced background network activity on idle channels, and paused it
  entirely while the app is in the background, for lower battery and data use

### Fixed
- Removing a relay in Settings now takes effect instead of reconnecting to a
  built-in default

## [0.25.2] - 2026-07-09

Chat images now open in a cinematic gallery: swipe between photos, pinch or
double-tap to zoom and pan, and download or open the original, with images
blurring up smoothly as they load. Voice notes now play through automatically,
rolling to the next one when the current clip ends. The message toolbar's Reply
and Quote actions have been reordered and relabeled for clarity, and a mute
indicator now shows in the sidebar voice roster while you're in a call.

### Added
- Cinematic image gallery in chat: horizontal swipe between images, pinch, wheel,
  and double-tap zoom and pan, a download/open-original button, and blurred
  placeholders that sharpen as each image loads
- Voice notes auto-play the next clip when one finishes
- Mute indicator in the sidebar voice roster while you're in a call

### Changed
- Reworked the message Reply and Quote actions: clearer labels, icons, and order

### Fixed
- Emoji picker no longer clips at the edges of reaction and status popovers

## [0.25.1] - 2026-07-09

Fixes an Android bug where community channels would silently stop loading after
the app was backgrounded or the screen turned off, leaving rooms blank until the
app was fully closed and reopened. Camera-off participants in a call now show a
softly blurred version of their avatar behind their tile instead of a flat
placeholder.

### Fixed
- Android: community channels no longer go blank after backgrounding the app or
  turning the screen off and returning — history now catches up within a couple
  seconds instead of requiring a full restart

### Changed
- Call tiles for participants with their camera off now display a blurred avatar
  backdrop instead of a plain placeholder

## [0.25.0] - 2026-07-09

New members now get a guided, full-page setup: generate and save a key, set up a
profile, and create or join a community, all in one flow. The community sidebar
header is reworked into a cleaner layout with a Discord-style menu that expands
inline for settings, invites, roles, and more. Cold-starting the Android app now
shows an animated Armada crest that holds until the app is ready instead of a
blank screen. This release also fixes community channels that could load blank
or slowly, or briefly flash the wrong channel's messages when switching, and
sharpens mobile layout on notched and landscape screens.

### Added
- Full-page onboarding for new members: a step-by-step wizard to generate a key,
  save it, set up your profile, and create or join a community, with every step
  after saving your key skippable
- Mesh chat on/off toggle in the channel-list sidebar, so you can turn mesh on or
  off without first opening a chat

### Changed
- Reworked community/server sidebar header: the name is now a menu that expands
  inline for settings, invite, create channel, roles, mute, leave, and delete;
  the community banner and icon layout are cleaned up
- Android cold start now shows an animated Armada crest that stays on screen
  until the app has painted, replacing the blank frame on launch
- The profile editor hides its edit pencils on touch devices for a cleaner look
- The platform relay is no longer pinned automatically; join it like any other
  community via its invite or server link

### Fixed
- Community channels that could load blank until an app restart, load slowly, or
  briefly flash the previous channel's messages when switching now load promptly
  and correctly, including channels with older history
- The Mentions view now surfaces mentions buried deep in a channel's history, not
  just recent ones
- Mobile safe-area handling on notched and landscape screens: content no longer
  slides under a side notch, the composer clears tall navigation bars, and the
  message placeholder stays put after rotating
- Status-bar icons over a community banner stay legible with a subtle scrim

## [0.24.0] - 2026-07-08

Replying in community chat now works the way you'd expect. Alongside the
existing "reply in thread", you can now send a normal inline reply that shows up
right in the timeline with a "replying to" bar, quoting the original message
(and a thumbnail if it had an image). This release also fixes replies and other
messages that could silently fail to send — especially on mobile after the app
had been backgrounded or the network changed — so what you send actually
arrives.

### Added
- Inline replies in community chat: reply to a message and your reply appears
  in the timeline with a bar quoting the original, distinct from replying in a
  thread

### Fixed
- Messages that could silently fail to send after a dropped or stale connection
  (common on mobile) now reconnect and deliver, and previously stuck messages
  are marked sent once they go through

## [0.23.0] - 2026-07-08

Communities gain two new ways to keep up with what matters to you. A Mentions
view collects every message that @-mentions you across the community's channels
in one place, and a Threads view lists the threads you're part of, newest reply
first. Both light up when there's something new, and tapping any entry jumps
straight to the message in its channel.

### Added
- Mentions view in the community sidebar that gathers every message mentioning
  you across all channels; the nav item highlights when you have a new mention,
  and tapping a mention jumps to it in its channel
- Threads view in the community sidebar listing threads you've taken part in,
  ordered by most recent reply, with unread highlighting and a tap to open the
  thread in its channel

## [0.22.0] - 2026-07-08

You can now send longer messages, and very long messages no longer flood the
timeline. The chat character limit is raised to 5,000, and messages that run
long are collapsed by default with a "Read more" toggle to expand them.

### Added
- "Read more" toggle that collapses long messages so they don't dominate the
  timeline, with a tap to expand and collapse again

### Changed
- Raised the chat message character limit from 2,000 to 5,000

## [0.21.1] - 2026-07-08

A reliability release focused on the Android app. Invite and share links now
point at the real site instead of an internal address, so they open correctly
for other people. Connections recover cleanly after dropping — messaging,
notifications, and voice no longer stay broken until you restart the app — and
joining a community that can't be reached now gives a clear error instead of
silently failing.

### Fixed
- Invite and share links (community invites, server/channel links, and signer
  pairing) now use the public site address, so they work when opened by others
- Messaging and notifications recover automatically after a connection drops,
  instead of staying broken until the app is restarted
- Joining or previewing a community that can't be reached now shows a clear
  error, and creating an invite over an unreachable connection warns you
- Signing in with a remote signer no longer times out prematurely on relays
  that require authentication
- More reliable message and notification delivery on relays with stricter limits



Messaging sync is overhauled so chat stays consistent everywhere. Messages now
arrive live in every channel of a server — not just the one you have open — and
unread badges light immediately across the sidebar, server rail, and app icon.
Servers that looked empty now load their channels reliably, time spent offline
is caught up on reconnect, and rooms no longer get stuck showing only a single
message. Unread badges also come to voice/text servers that previously had none.

### Added
- Unread badges for Concord (V1) servers, shown in the channel list, server rail, and folders

### Changed
- All chat now syncs through a single unified pipeline, so timelines and unread counts stay in agreement across every view
- Messages sent to any channel arrive and badge live, without needing to open that channel first
- Time spent offline is replayed on reconnect (up to 7 days), so you don't miss messages

### Fixed
- Servers that appeared empty now load their channels and message history
- Unread badges no longer go stale when messages sync in the background
- Rooms that received a single message no longer get stuck hiding the rest of their history
- No longer need to resync a community after logging in
- Empty timelines show a loading state instead of briefly flashing "no messages yet"

## [0.20.0] - 2026-07-08

This release overhauls mobile navigation and polish: swipe-to-dismiss on image
lightboxes, smoother community/channel switching on mobile, a redesigned DM
sidebar that matches the community layout, improved iOS PWA behaviour, and
a richer thread panel with context menus, message deletion, and collapsing of
consecutive replies. Voice calls gain per-participant volume controls.

### Added
- Swipe down to dismiss image lightboxes (banner/avatar previews and in-chat images)
- Per-participant volume control in the mobile call's audio settings
- Thread panel: right-click context menu with Copy link, Delete message, and View event JSON
- Thread panel: consecutive replies from the same author now collapse into a compact view, matching the main timeline

### Changed
- DM list sidebar redesigned to match the community layout (Messages sub-header, divider, consistent header height)
- DM and Mesh rail buttons now show the same active indicator blade as communities
- Mobile: tapping a community or server now lands on the channel list instead of the last-viewed channel
- Redirects after login now go to synced servers rather than the join screen
- Community banner on mobile is now a header background instead of a stacked block

### Fixed
- Mobile swipe glitches when switching communities and servers
- Channel list and sidebar header no longer flash or shift when switching communities
- iOS standalone PWA: fixed bottom gap and scroll-lock pinned correctly to `<html>`
- iOS theater-mode call: status bar area now clears correctly when closing the call stage
- Kick in voice calls now takes effect immediately for active participants
- Service worker cache now rotates per deploy, preventing stale assets after updates
- Community creation now snapshots the correct set of relay hints

## [0.19.3] - 2026-07-07

GIF search now uses a new provider for more reliable results, and signing in
with a remote signer (such as Amber) works against Armada's own relay, so you no
longer need a separate rendezvous relay to log in that way.

### Changed
- GIF search now uses GIFverse for more reliable results

### Fixed
- Signing in with a remote signer (e.g. Amber) now works using Armada's relay as
  the rendezvous point

## [0.19.2] - 2026-07-07

Small quality-of-life update: mute a community or channel straight from its
header menu (handy on touch screens), plus two Android fixes — text-selection
controls no longer render as black boxes, and a one-time prompt helps you
exempt Armada from battery optimization so notifications keep working.

### Added
- Mute options in the channel and community header ⋮ menus, so muting no
  longer requires a right-click
- Android app: a one-time prompt to allow background usage when battery
  optimization would otherwise cut off notifications

### Fixed
- Android app: black boxes no longer appear behind the text-selection toolbar
  and selection handles

## [0.19.1] - 2026-07-07

Fixes voice and video calls on the Android app and the desktop app: both now
properly request microphone and camera access, so calls no longer fail with a
silently denied mic.

### Fixed
- Android app: microphone and camera permissions are now requested, so voice
  and video calls work instead of the mic being silently denied
- Desktop app: microphone and camera access is granted for calls (with the
  required macOS usage prompts), and other permission requests are denied
  unless they come from Armada itself

## [0.19.0] - 2026-07-07

Organize your community rail Discord-style: drop one community onto another to
create a folder, and long-press any icon to pick it up and reorder — folders,
order and all synced across your devices. Notifications get personal too:
right-click a community or channel to mute it everywhere, including push
notifications. Plus @mentions in thread replies, a redesigned status dialog
with an emoji picker, and a Voice server setting for diagnosing call
connectivity.

### Added
- Folders on the community rail: drop one community onto another to group
  them, drag in and out to organize, and right-click a folder to rename or
  remove it; collapsed folders show a mini icon grid with unread indicators
- Reorder the rail by long-pressing an icon to pick it up, with a live
  preview of where it will land; the layout syncs across your devices
- Mute a community or channel from its right-click menu — muted places stop
  notifying (including push notifications), stop bolding, and stop counting
  toward badges, while mentions still get through; mutes sync across devices
- @mentions in thread replies
- "Voice server" setting with a live reachability check, so you can see and
  change the server voice calls run through

### Changed
- The status dialog is now a proper modal with a full emoji picker for the
  status emoji

### Fixed
- Joining a voice channel right after opening a community no longer fails
  with a spurious "no voice server" error

## [0.18.0] - 2026-07-07

Voice calls arrive in newer encrypted communities, with verified participant
identities. Calls also get quality-of-life upgrades: right-click a participant
to adjust their volume or mute them, the call UI stays alive while you browse
other channels, and the sidebar shows live speaking indicators. Plus fixes for
encrypted-community messages that notified but never appeared, and a bug that
could make your microphone transmit silence.

### Added
- Voice calls in newer encrypted communities, with per-participant identity
  verification
- Right-click a participant — on their call tile or in the sidebar voice
  roster — to adjust their volume or mute them for yourself; per-user volume
  now works on mobile too
- Voice memos in encrypted communities and direct messages
- New "Media servers" settings section to manage where your uploads are stored

### Changed
- The call view and call bar stay alive when you navigate to other channels
- The participant list for a call you're in now comes straight from the live
  call connection, so it no longer shows ghost or missing participants
- The sidebar voice roster shows live speaking rings while you're in that
  channel's call, and the call bar no longer duplicates the participant list
- Direct messages are now always limited to people you follow, and messages
  from strangers are never fetched or notified
- Removing a server now stays removed across your devices

### Fixed
- Encrypted-community messages that triggered a notification but never
  appeared in the channel now show up reliably, including after being offline
  for a while
- Encrypted video and audio attachments now play instead of silently failing
- The microphone no longer transmits silence in calls when background-noise
  removal is enabled
- Uploads with unusual file extensions now play correctly
- Unread indicators on the community rail now clear as soon as you read the
  channel, without needing a reload
- Speaking indicators update more promptly

### Removed
- The experimental voice feature in older encrypted communities (superseded
  by the new call system)

## [0.17.6] - 2026-07-06

Adds unread tracking to Concord v2 channels, and gives the active channel a
clearer highlight everywhere.

### Added
- Concord v2 channels now show unread indicators (bright/bold text, and an
  '@' pill for mentions) on both the channel list and community icon

### Changed
- The active channel now gets a clearer filled highlight, consistent across
  NIP-29 rooms and Concord v1/v2
- Improved text contrast on colored backgrounds (e.g. the active-channel
  highlight) so text stays readable regardless of the color

## [0.17.5] - 2026-07-06

Armada links now open straight into the Android app: tapping an
https://armada.buzz invite or shared channel link lands you in the right room
instead of the browser. Also fixes a background notification bug that could
quietly drain the battery overnight on flaky connections.

### Added
- armada.buzz links (invites, shared channels) now open directly in the
  Android app

### Fixed
- Background notifications no longer drain the battery by reconnecting in a
  tight loop when a relay or network keeps dropping the connection

## [0.17.4] - 2026-07-06

Fixes member promotion in newer communities: "Make moderator" was silently
doing nothing, and "Make admin" published correctly but the promoter often
didn't see the change take effect right away.

### Fixed
- "Make moderator" now actually grants moderator permissions instead of
  silently doing nothing
- Promoting or demoting a member now shows up immediately for the person who
  made the change, and failures are now reported instead of failing silently

## [0.17.3] - 2026-07-06

Polishes invites and a few everyday interactions. Inviting someone is now
simpler: the invite dialog leads with a single action and tucks the extra
options away, and direct invites to a known contact are delivered more
reliably. Copying an invite link now works everywhere, including in the mobile
and desktop apps, with clear per-link feedback. Logging in is a cleaner
single-step dialog, and typing indicators get a friendlier Signal-style look.

### Changed
- The invite dialog now leads with a single primary action and keeps advanced
  options behind a disclosure, with an info popover explaining the choices
- Logging in is now a streamlined single-input dialog
- Typing indicators now show a Signal-style avatar stack with a pulsing-dot pill

### Fixed
- Copying invite links now works in the mobile and desktop apps (not just the
  browser), with clear feedback on the link you copied
- Direct invites to a known contact are delivered more reliably

## [0.17.2] - 2026-07-06

Focuses on making communities load and feel faster: chat history, invites, and
community details are now cached locally after they're first decrypted, so
reopening a community is quicker and puts less strain on remote signers. Also
fixes a bug where switching communities could briefly show the previous
community's messages while the new one was still loading.

### Changed
- Chat history, invites, and community details are now cached locally after
  decrypting, so reopening a community loads faster and is easier on remote
  signers
- Community details (members, channels, banned users) now sync in the
  background for all your communities, not just the one you have open

### Fixed
- Switching communities no longer briefly shows the previous community's
  messages while the new one is still loading

## [0.17.1] - 2026-07-05

Your settings now follow you across devices more completely, and a few rough
edges are smoothed out: opening a community on mobile is a single clean slide
instead of a jumpy double transition, the community sidebar scrolls properly by
touch again, and links at the end of a message no longer swallow the space
before them.

### Changed
- More of your setup now syncs across devices, including your community and
  sidebar order, added relays, and the last channel you had open in each
  community

### Fixed
- Opening a community on mobile now transitions smoothly in one step instead of
  visibly jumping through the channel list first
- The community sidebar can be scrolled by touch again on mobile
- A link at the end of a message no longer glues itself to the preceding word

## [0.17.0] - 2026-07-05

Brings Slack-style threads to every conversation: reply to any message and the
whole exchange folds into a tidy thread you can open on the side, with a badge
showing who's taken part. Communities gain an info dialog with a click-to-zoom
banner and icon, the sidebar rail is now one list you can drag to reorder however
you like, and mobile chat headers show the community's avatar and name. You'll
also get native notifications for the newest generation of communities, typing
`#channel` jumps straight to that channel, and chat history loads faster and
deeper.

### Added
- Slack-style threads: nested replies fold into a side panel across all
  conversations, with a badge showing the participants who've replied
- Community info dialog with a click-to-zoom banner and icon, merged with
  community settings into one view
- Native notifications for the newest generation of communities
- Community avatar and name in the mobile chat header

### Changed
- The sidebar community rail is now a single list you can drag to reorder freely
- Typing `#channel` now jumps to that channel in the current community
- Chat history loads faster and backfills deeper when opening a conversation

## [0.16.0] - 2026-07-05

Introduces the next generation of Armada's private community protocol as the
new standard for communities, built for stronger privacy and spam resistance.
New communities now use it by default, and existing communities remain fully
usable alongside it. This release also adds a safety net that keeps the app on
its feet if a screen hits an error, and fixes a couple of stubborn glitches
around leaving communities and removing servers.

### Added
- New private community protocol, now the default when creating communities,
  with joins and invites that work everywhere
- App-wide error screen that recovers gracefully instead of showing a blank
  page when something goes wrong

### Fixed
- Leaving a community that failed to load now works and reports any problem
  instead of doing nothing
- The "Remove server" option no longer disappears for servers you added, and
  removed servers no longer reappear in the sidebar

## [0.15.4] - 2026-07-03

Cleans up the Concord interface by removing the "end-to-end encrypted" badges,
shields, and labels that appeared throughout voice and community screens. The
extra chrome was visual noise; the interface is now quieter without changing how
anything works.

### Changed
- Removed the encryption shields and "end-to-end encrypted" labels from voice
  call bars, the join-voice button, community sidebars and icons, voice
  settings, and the About page

## [0.15.3] - 2026-07-02

Makes experimental CORD communities actually work across members: messages sent
by one member are now visible to everyone else (previously each member only saw
their own). CORD communities now gather on the protocol's standard relay set
and authenticate themselves to relays that gate encrypted-message reads — on
web, desktop, and in Android background notifications. Also updates the CORD
message envelope to the latest protocol draft.

### Fixed
- Messages in CORD communities are now visible to other members; previously
  members could publish but never read each other, so every conversation
  looked one-sided
- CORD communities connect to the protocol's standard relays; existing
  communities pick them up automatically
- Android background notifications for CORD communities now work on relays
  that require authentication, even when the app hasn't been opened since boot

### Changed
- Updated the CORD message envelope to the latest protocol draft; experimental
  messages sent with earlier builds are no longer readable

## [0.15.2] - 2026-07-02

Adds experimental support for CORD, the next generation of Armada's private
community protocol, built for stronger privacy and spam resistance. Invites to
CORD communities can be accepted everywhere; creating one is an opt-in preview
in development builds while the protocol stabilizes. Messages in CORD
communities also trigger native Android notifications.

### Added
- Experimental CORD community protocol: joining CORD community invites works
  everywhere, and creating CORD communities is available as a preview in
  development builds
- Native Android notifications for messages in CORD communities

## [0.15.1] - 2026-07-02

Fixes a nasty cache bug where messages and member lists from one room could
leak into another after switching rooms — most visibly in Concord communities,
where another channel's messages could appear (and stick) in the wrong channel.
Affected rooms clean themselves up automatically on the next visit.

### Fixed
- Switching between rooms could save one room's messages into another room's
  local cache, making the wrong messages (and their senders in the member list)
  show up there on later visits. Already-polluted caches self-heal.
- Switching between communities could briefly show — or fall back to — the
  previous community's member list, name, and moderation state, which could
  wrongly hide messages.

## [0.15.0] - 2026-07-02

Armada is now installable as an app. Add it to your home screen or desktop for a
full-screen, offline-capable experience, and share links and images straight
into a chat from other apps. This release also adds "View on Ditto" shortcuts
throughout, so you can jump to the richer social view of any post, profile, or
hashtag on ditto.pub.

### Added
- Install Armada as an app (PWA): add it to your home screen or desktop for a
  standalone, full-screen window, with offline caching and faster loads.
- Share into Armada: send links and images from other apps directly into a chat.
- "View on Ditto" throughout: embedded posts, the message menu, profiles, and
  the DM header link out to the full post/profile on ditto.pub.
- Hashtags in messages and events are now tappable and open the hashtag feed on
  ditto.pub.

### Changed
- Embedded posts are rendered as cleaner, Ditto-style note cards.
- Links to posts and profiles that Armada doesn't expand now open on ditto.pub.

## [0.14.0] - 2026-07-01

A big Discord-style chat refresh. The interface now feels more familiar if
you're coming from Discord: a quick switcher (Ctrl/Cmd+K) to jump anywhere,
date separators and an unread "New" divider in the message timeline, live voice
participants shown directly in the sidebar under their channel, markdown code
blocks in messages, and a cleaner collapsible settings page.

### Added
- Quick switcher (Ctrl/Cmd+K): fuzzy-search servers, channels, DMs, and
  settings from a palette. Alt+Up/Down hops between channels in the current
  server.
- Date separators in the message timeline group messages by day, with "Today"
  and "Yesterday" labels.
- Unread "New" divider marks where you left off in a channel.
- Voice participants are shown as an indented roster under their channel in the
  sidebar, so you can see who's in a call at a glance.
- Markdown code blocks and inline code in messages are now rendered with syntax
  highlighting.

### Changed
- Settings page is reorganized into collapsible sections, making it easier to
  find what you're looking for.
- Member list and channel sidebar have been polished for a more Discord-like
  feel.

## [0.13.2] - 2026-07-01

Sharper notification taps: the message you tapped now shows up in the very
first frame instead of popping in a moment after the room opens.

### Fixed
- Opening a chat from a notification no longer shows the room briefly without
  the new message — it's there on the first paint.
- Navigating to a screen you haven't visited yet this session no longer pauses
  on the splash while it loads.

## [0.13.1] - 2026-07-01

Faster and more dependable. The app now opens straight into your chats — the
last messages in every room appear instantly instead of loading spinners, even
when launched from a notification tap. On Android, background notifications now
survive reboots and app updates, and Settings warns you (with a one-tap fix)
when battery optimization would silence them. Bluetooth mesh chat is now
opt-in, so nothing Bluetooth-related happens until you turn it on.

### Changed
- The app opens instantly to your recent messages instead of loading spinners,
  including when launched from a notification tap.
- A branded splash screen replaces the blank frame while the app starts up.
- Bluetooth mesh chat is now opt-in: it stays completely off (no permission
  prompts, no persistent notification) until you enable it, and you can turn
  it off from the mesh screen.
- The mesh icon only appears on devices that can actually use it, so web and
  desktop no longer show a dead-end Bluetooth screen.

### Fixed
- Background notifications on Android resume automatically after a reboot or
  app update instead of staying off until you reopen the app.
- Notification settings now warn when battery optimization would stop
  background notifications, with a one-tap button to fix it.

## [0.13.0] - 2026-06-30

Armada now works with no internet at all. On Android, a new Bluetooth mesh lets
you chat with people nearby — your phones relay messages to each other directly,
so you can talk in channels or one-on-one even with no signal and no Wi-Fi. It's
compatible with bitchat, so Armada and bitchat users on the same mesh see each
other. You can pick a nickname or stay incognito, and @-mention nearby people
and run quick commands like /me right from the mesh composer. Signing up no
longer needs a connection either: you can create your account offline, and
anything you send while offline is queued and sent automatically once you're
back online.

### Added
- Bluetooth mesh chat on Android: talk to nearby people with no internet, in
  channels or direct messages. Compatible with bitchat.
- Choose a nickname or stay incognito on the mesh, with a colored name and a
  tappable profile popover to message or mention a peer.
- @-mentions and slash commands (like /me and /shrug) in the mesh composer.
- A "Nearby" roster and in-chat members toggle show who's currently reachable
  over the mesh.
- Offline signup: create your account without a connection.

### Changed
- Messages you send while offline are queued and sent automatically when you
  reconnect.

## [0.12.0] - 2026-06-30

The Android app now feels like a real app instead of a website in a box. The
keyboard pushes the message box up instead of covering it, buttons buzz when you
tap them, sharing an invite opens the system share sheet, and the status bar
matches your theme. Tapping is crisper — no more grey flashes, accidental text
selection, or rubber-band bounce — and touch targets, headers, and the server
rail are sized for fingers. On small phones, the less-used channel actions tuck
themselves into the channel menu so the channel name always has room.

### Added
- Buttons and toggles give haptic feedback on tap.
- Sharing an invite opens the native share sheet.

### Changed
- The on-screen keyboard now pushes the message box up above it instead of
  covering it.
- The status bar tint follows the app theme.
- Larger, finger-friendly headers, action buttons, and inputs on touch devices;
  the server rail is slimmer on phones.
- Controls that only appeared on hover (member actions, edit buttons, and more)
  now show on touch too.
- On narrow screens the channel header tucks the pins and events actions into
  the channel menu when there isn't room for everything.

### Fixed
- No more grey tap-flash, accidental long-press text selection, or whole-page
  rubber-band scrolling in the app.
- The whole app can no longer be pinch-zoomed like a web page.

## [0.11.0] - 2026-06-30

Encrypted communities now feel like the rest of chat. You can @-mention people
right from the composer, run quick slash commands like /me and /shrug, and see
who's typing by name. The channel name shows in the message box, messages send
instantly without a spinner, and the emoji picker sits neatly against the
composer.

### Added
- Mention people with `@` in encrypted-community channels, picking from members
  and recent participants.
- Slash commands in encrypted communities — `/me`, `/shrug`, `/tableflip`,
  `/unflip`, `/slap`, and `/mention`.

### Changed
- The typing indicator in encrypted communities now names who's typing
  (e.g. "Alice and Bob are typing…") instead of a generic "Someone".
- The message box shows the channel name (e.g. "Message #general") instead of a
  generic "(encrypted)" hint.
- Messages in encrypted communities send instantly, without a sending spinner;
  a failed send still offers a retry.
- The emoji shortcode menu hugs the message box for a short list instead of
  floating away from it.

## [0.10.0] - 2026-06-30

Notifications now open the right place instantly. Tapping a message notification
jumps straight to that conversation and the message is already on screen — no
waiting for the chat to catch up — even when the app was fully closed. Encrypted
communities get the same instant arrival. There's also more to do inside chat:
watch YouTube together and run little in-chat apps, with clearer voice thanks to
background-noise removal.

### Added
- Watch YouTube videos together in sync, and run lightweight in-chat apps,
  right inside a channel.
- Background-noise removal for voice calls, with a toggle in settings.

### Changed
- Tapping a notification opens the exact conversation it's about and shows the
  message immediately, instead of reloading the app and landing on the wrong or
  default room — including after the app has been closed.
- Encrypted community messages a notification was about now appear the instant
  the channel opens.
- Encrypted communities are faster to open and load.

## [0.9.2] - 2026-06-28

Direct messages get a real workout: search within a conversation, mute someone,
and a smoother way to start a new chat — plus steadier delivery after the app
has been backgrounded. Replies are also clearer everywhere: the "replying to"
hint shows who you're replying to and a preview of their message, and tapping it
jumps straight to the original (with a gentle highlight), in encrypted
communities too.

### Added
- Search within a direct-message conversation from the thread header.
- Mute a person from a direct-message conversation to hide it and stop seeing
  their messages.
- The reply hint above a message now previews the message being replied to, and
  clicking it scrolls to and highlights the original — including in encrypted
  communities.
- Visiting an invite link now adds that server to your rail.

### Changed
- Starting a new direct message and the conversation list are reworked for a
  smoother, clearer flow.
- Direct messages now render consistently with group and community chat.

### Fixed
- Direct messages keep arriving after the app has been in the background,
  catching up the moment you return or reconnect, and a message that arrived via
  notification just before opening the thread no longer goes missing.

## [0.9.1] - 2026-06-27

Chat is faster and steadier, especially on Android. Opening a channel no longer
stalls or flashes a half-empty timeline before history appears, new messages
arrive promptly even after the app has been backgrounded, and tapping a message
notification jumps you straight to that channel with the message already on
screen. The Android back gesture now steps back through the app the way you'd
expect.

### Changed
- Tapping a message notification now opens the exact channel it came from, with
  the message already loaded, instead of dropping you on the community.
- The Android back gesture and button now reveal the channel list from a
  conversation and step back through the app, rather than navigating away
  unexpectedly.

### Fixed
- Opening a channel is much faster and no longer stalls for several seconds or
  flashes a single message followed by a blank gap before history loads.
- New messages now keep arriving reliably after the app has been in the
  background, catching up the moment you return or reconnect.
- New messages in busy communities no longer stop appearing once a channel
  accumulates lots of reactions.
- Switching channels keeps the previous conversation on screen until the next
  one loads instead of flashing a loading skeleton.
- Connecting to sign-in-required relays with a remote signer is more reliable
  and no longer gets stuck retrying, so those rooms receive messages.

## [0.9.0] - 2026-06-26

Navigating channels on mobile now feels like Discord: swipe from the left edge
to reveal the channel list and swipe back (or tap a channel) to return, and
Armada reopens you in the last channel you were reading instead of a list.
One-to-one voice calls now work out of the box, Android groups a busy room's
messages into a single notification with a firmer buzz, and reopening encrypted
communities is more reliable.

### Added
- Swipe navigation on phones: drag from the left edge to reveal the channel
  list and drag back or tap a channel to slide into the conversation, on
  servers, communities, and direct messages.
- Armada remembers the last channel you had open in each server and community
  and reopens it on return, instead of dropping you on the channel list.

### Changed
- Android now bundles all the messages from one conversation into a single
  notification (showing the sender's name and avatar) instead of a separate
  notification per message, and gives new messages a stronger buzz.
- The mobile call bar is now a compact single row that no longer covers the
  message box or leaves a gap above it.

### Fixed
- One-to-one voice calls now work out of the box, falling back to a voice-capable
  relay when your own relays don't support calls.
- Community icons no longer flicker to a blank placeholder when reloading.
- New messages no longer briefly go missing when first opening a server channel
  (including when opening one by tapping a notification).
- You're no longer wrongly shown a "Join channel" banner in a channel you've
  already joined when reopening the app.
- Reopening the app with a remote signer no longer briefly shows zero
  communities or re-prompts you with invites to communities you've already
  joined.

## [0.8.3] - 2026-06-26

Encrypted communities load and scroll much faster, with reactions and images
that just work, and message notifications now arrive by default.

### Changed
- Message notifications for communities are on by default, so you're notified of
  new messages unless you turn them off in settings.

### Fixed
- Images and other attachments sent in encrypted communities now display
  correctly for everyone, both in the message and in the composer preview before
  you send.
- Opening and scrolling encrypted communities is much faster: the channel no
  longer stalls while loading long histories, and reactions now appear together
  with the messages instead of lagging behind.

## [0.8.2] - 2026-06-25

Notifications for encrypted communities now show who sent the message and a
preview of it, alongside the community and channel it came from. There's also a
new About page explaining the two ways to talk in Armada and what stays private.

### Added
- An About page that explains the two ways to talk — running your own server or
  decentralized encrypted chat — and what each keeps private. Reachable from
  Settings and the welcome screen.

### Changed
- Notifications for encrypted communities now show the sender's name and a
  preview of the message, along with the community and channel it came from,
  instead of a generic "new message" notice.

## [0.8.1] - 2026-06-25

Voice calls now work on the Android and desktop apps, the encrypted-community
message actions work on touch, and a couple of mobile layout glitches are gone.

### Fixed
- Voice call buttons now appear in the app on Android and desktop, not just the
  web client — group, direct-message, and encrypted-community calls can all be
  started from the native apps.
- Message actions (react, reply, delete) now work in encrypted communities when
  tapping on a touch screen.
- The close button on the fullscreen image viewer no longer hides behind the
  status bar on Android.
- The Settings header now matches the rest of the app's headers.

## [0.8.0] - 2026-06-25

Notifications now tell you who did what. On Android, a message, mention, reply,
or reaction shows the sender's name and avatar, the reaction's actual emoji, and
a preview of the message — instead of a generic "someone reacted." Settings has
been redesigned into clean grouped sections, communities and direct messages
open instantly from a local cache, and there's a new recovery tool to restore
encrypted communities that went missing from your list.

### Added
- Recover encrypted communities that dropped off your list: an advanced settings
  tool scans your local cache, every copy of your list across relays, and your
  invites to find communities you've lost, then lets you choose which to restore.

### Changed
- Notifications now show the sender's name and avatar, the emoji someone reacted
  with, and a preview of the message, so you can tell at a glance who did what.
- Settings has been redesigned into grouped sections with cleaner labels and
  rows, and the theme builder now opens in a dialog.
- Communities, channels, and direct messages now open instantly from a local
  cache and refresh in the background, removing the loading skeletons on a cold
  start.
- Refined the login, signup, and community settings dialogs.
- Refreshed the app icon to a cleaner mark.
- Logging out of your last account now wipes cached data from the device, and
  private pages can no longer be reached once you're signed out.

### Fixed
- Desktop and Android builds no longer show a phantom "localhost" server when no
  relay is configured.

## [0.7.0] - 2026-06-24

Plan together and share what you're up to. Admins and moderators can now create
date- and time-based events in a channel, and any member can RSVP Going, Maybe,
or Can't go with live attendee tallies. Set a personal status that shows next to
your name across the member list and profile cards. On Android, Armada now asks
to turn on notifications right when you open it instead of leaving them buried
in Settings, and you can point your direct messages at your own relays.

### Added
- Channel events: admins and moderators can schedule date- and time-based
  events in a channel, and any member can RSVP Going, Maybe, or Can't go.
  Upcoming events appear in a slide-down bar from the channel header with live
  attendee counts.
- Personal statuses: set a short status (with an optional emoji) that shows next
  to your name in the member list and on profile cards. Set or clear it from the
  account menu or your own member-list menu.
- Direct messages can now use your own relays: when you turn this on, Armada
  picks up the direct-message relays you've already published and keeps them in
  sync so other apps know where to reach you.

### Changed
- On Android, Armada now prompts to enable notifications when you first open the
  app, rather than only offering the toggle in Settings.

## [0.6.0] - 2026-06-24

Better interop with other community chat apps, plus faster and more reliable
loading. Encrypted images shared from other clients now decrypt and display
inline, and images you send are encrypted to match. Community names, icons, and
member lists now paint instantly from a local cache on refresh instead of
reloading from scratch, and avatars and names fill in more reliably. Owners and
admins are now distinguished in the member list.

### Added
- Encrypted images shared from other community chat apps now decrypt and display
  inline, and images you send are encrypted the same way so they show correctly
  for everyone.
- Encrypted community icons and banners now display in the server rail, header,
  and sidebar.
- Owners and admins are distinguished in the member list with separate badges (a
  crown for owners, a shield for admins).

### Changed
- Community names, icons, and member lists now paint instantly from a local
  cache when you refresh, instead of reloading from scratch each time.
- New messages in communities now appear live, and busy rooms load faster.
- Avatars and display names fill in more reliably instead of occasionally
  freezing as missing for several minutes.

### Fixed
- Member roles and permissions set by owners and admins now resolve correctly
  for communities created in other apps.
- The invite prompt no longer pops up for communities you have already joined
  while the app is warming up.

## [0.5.2] - 2026-06-24

A community chat fix-up release. Accepting several invites in a row no longer
wipes your community list, custom emoji now show as images in community
messages and reactions, image attachments with malformed links from some media
servers are repaired automatically, and busy community rooms are noticeably
smoother.

### Fixed
- Accepting several community invites back to back could wipe your community
  list (and lose access to those rooms); invites are now accepted safely in
  sequence.
- Custom emoji now render as images in community messages and reactions instead
  of showing as raw `:shortcode:` text.
- Image and file attachments that came back from some media servers with a
  malformed link are now repaired, so they preview and send correctly.
- Active community rooms with lots of messages and reactions are much smoother;
  the message list no longer redraws everything on each new message.

## [0.5.1] - 2026-06-24

A polish release for dialogs and message actions. Every dialog now shares the
same cut-corner "chrome" look, their headings scale to fit, and tall dialogs
scroll instead of running off the screen on phones. On smaller desktop and
tablet windows, the per-message action buttons no longer float out of place or
become unclickable.

### Changed
- All dialogs share a consistent cut-corner style, with headings that scale to
  fit so they no longer overflow on narrow screens.

### Fixed
- Dialogs that are taller than the screen now scroll instead of overflowing off
  the bottom on mobile.
- The hover toolbar on a message could float out of place and become unclickable
  on smaller desktop and tablet windows; its buttons now stay aligned and
  clickable, and the "(edited)" marker no longer overlaps them.

## [0.5.0] - 2026-06-24

A big release for serverless communities. You can now run a community end to
end without a server in charge: edit its name, description, logo, and banner;
create and rename channels; build custom roles and hand out fine-grained
permissions; and moderate with kick, ban, unban, and hide. Communities support
message editing and live "someone is typing" indicators, and invite links can
carry an expiry (never, 1, 7, or 30 days) and a label, and be revoked so a
shared link stops working. Owners can permanently dissolve a community. Adding
and inviting people got a fresh look, with a smart paste box that accepts links,
invite tokens, or a bare domain, a people search that surfaces the folks you
follow first, and full cross-compatibility with Vector invite links.

### Added
- Edit a community's name, description, logo, and banner.
- Create and rename channels within a community.
- Custom roles with per-permission controls (manage roles, metadata, channels,
  kick, ban, and more).
- Moderation: kick, ban, unban, and hide messages.
- Message editing in communities.
- Live typing indicators showing when someone is composing a message.
- Invite links can expire (never, 1, 7, or 30 days), carry a label, and be
  revoked.
- Owners can permanently dissolve a community.
- A people search when inviting that surfaces accounts you follow first, plus a
  paste button.

### Changed
- Redesigned Add and Invite dialogs.
- Community invite links are now fully compatible with Vector.

## [0.4.7] - 2026-06-24

A chat readability and touch-friendliness release. The per-message action
buttons (react, reply, thread, edit, pin, delete) now float in a panel above the
message instead of crowding the author's name, so long names and titles are no
longer cut off. The buttons are larger on phones and tablets, the panel only
appears on tap (and stays put until you deliberately tap an action, so you won't
fat-finger a delete), and on desktop a click no longer highlights a message.
Reaction emoji also sit properly centered in their pills.

### Changed
- Message action buttons now float in a panel above the message rather than
  inline with the author's name, and are larger and easier to tap on phones and
  tablets.

### Fixed
- A long username is no longer truncated by the author's title badge.
- On desktop, clicking a message no longer highlights it; the action panel still
  appears on hover.
- Reaction emoji are now vertically centered in their pills.

## [0.4.6] - 2026-06-23

A reliability release for chat, encrypted messages, and offline use. Encrypted
direct messages now open instantly and stay decrypted when you switch back to a
thread, filling in from the newest message down. Chat stays pinned to the
bottom as images, link previews, and reactions load in, so the view no longer
drifts upward. Your channel lists, conversations, and account names now survive
a flaky or offline connection instead of vanishing, and channels from different
servers no longer bleed into each other.

### Changed
- Direct messages open noticeably faster and reveal newest-first; revisiting a
  thread no longer re-decrypts everything from scratch.
- Account names and avatars in the account switcher load instantly from local
  storage, including when you're offline.

### Fixed
- Chat now stays anchored to the bottom while images, link previews, and
  reactions finish loading, instead of drifting up the screen.
- The message composer no longer briefly flashes a "join to send" prompt for
  members while a channel is still loading.
- Channel lists, direct-message conversations, and threads no longer disappear
  or shrink on a slow, flaky, or offline connection.
- Channels from one server no longer show up as phantom rooms on another server
  that shares the same identity.

## [0.4.5] - 2026-06-23

Messages everywhere now feel instant and your server list stops vanishing.
Group and encrypted-community messages send optimistically — they appear the
moment you hit send, the box clears right away, and you can fire off several in
a row without the app locking up. Deleting an encrypted-community message
removes it immediately. Separately, the server rail and encrypted-community
list no longer flicker out and disappear on a flaky connection.

### Changed
- Group and encrypted-community messages appear immediately on send and the
  compose box clears right away, instead of waiting for the server. You can
  send several in a row without the input locking up between them.
- Deleting a message in an encrypted community now hides it immediately.

### Fixed
- The server list (the icons on the left) no longer briefly appears and then
  disappears on a slow or flaky connection.
- The encrypted-community list and its channels no longer flicker out and
  vanish when the connection is struggling.
- A message that fails to send now shows a retry option inline instead of
  silently disappearing.
- Prevented a rare case where saving your server or community list during a
  connection hiccup could wipe it.

## [0.4.4] - 2026-06-23

Direct messages now send instantly. Your message appears the moment you hit
send and the input clears right away, so you can fire off several messages in a
row without the app freezing up while it waits. If a message can't be delivered
it's now shown clearly with a tap-to-retry option instead of silently
disappearing.

### Changed
- Sent direct messages appear immediately and the compose box clears right
  away, instead of waiting for the message to reach the server first.
- You can send several direct messages back-to-back without the input locking
  up between them.

### Fixed
- Rapid-fire direct messages no longer thrash and stall against background
  work, which previously made a burst of messages crawl out one at a time.
- A direct message that fails to send now shows a "Not delivered — tap to
  retry" prompt instead of vanishing with no explanation.

## [0.4.3] - 2026-06-23

A server's name, avatar, and channel list now stick around on a shaky or
dropped connection instead of collapsing to a bare address and a blank list.
The server's details are remembered on your device and shown immediately, even
when the network is struggling to reach it.

### Fixed
- Server name and avatar no longer disappear (replaced by the raw address and a
  placeholder icon) when the connection is flaky; the last-known details are
  remembered and shown instantly.
- The channel list no longer blanks out just because fetching the server's
  name/icon failed; it stays visible as long as the channels are known.

## [0.4.2] - 2026-06-23

Your channel list no longer reloads itself in the background. It now loads
instantly from your device and stays put, instead of refetching every minute
and flickering when you switch servers or reload.

### Fixed
- The channel list stopped constantly refetching. It loads instantly from local
  storage, no longer polls in the background, and only refreshes when a channel
  is actually created or changed.

## [0.4.1] - 2026-06-23

Fixes the Windows desktop app, which opened to a blank screen on first launch
and then wouldn't load your existing servers after signing in — leaving you
stuck on the "add a server" screen. Also keeps a message's hover toolbar from
overlapping the text on grouped messages.

### Fixed
- Windows desktop app no longer opens blank on first launch; signing in now
  correctly restores your existing servers instead of stranding you on the
  add-a-server screen.
- The hover toolbar on grouped (continuation) messages no longer covers the
  message text.

## [0.4.0] - 2026-06-23

Your chats now stick around when you reload. Armada keeps your conversations,
channels, communities, and profiles on your device, so a refresh shows
everything instantly instead of going blank while it reconnects. The welcome
and post-login screens also got a cleaner, refreshed look.

### Added
- Offline history: your messages, direct messages, encrypted communities,
  joined channels, and profiles are saved on your device and load instantly on
  refresh, even before the network reconnects.

### Changed
- Refreshed the welcome and post-login screens with a cleaner look and a
  step-by-step sign-in progress view.

## [0.3.1] - 2026-06-23

Logging in now shows a brief loading screen while Armada catches up — pulling
your settings, your channels, and recent messages — so the app opens ready to
use instead of filling in piece by piece. This release also fixes standalone
(non-hosted) clients that wrongly showed a phantom local server that didn't
exist.

### Added
- A post-login loading screen that syncs your settings, channel list, and
  recent messages before dropping you into the app, so nothing pops in late.

### Fixed
- Standalone clients no longer show a bogus "localhost" server that isn't
  reachable; they now correctly start with no servers until you add one.

## [0.3.0] - 2026-06-23

The Android app now delivers instant push notifications on its own — no Google
or third-party push service involved. Messages, mentions, replies, reactions,
direct messages, and community voice channels all ping you the moment they
arrive, even when Armada is closed, signed in with any login method. This
release also polishes the mobile experience with a branded launcher icon and
splash screen and fixes several layout glitches.

### Added
- Instant native push notifications on Android, delivered directly without
  Google/FCM: messages, mentions, replies, reactions, direct messages, and
  community channels. Works with any login method (key, signer, or remote
  signer) and notifies you even when the app is closed.
- A branded Armada launcher icon and splash screen on Android.

### Fixed
- Mobile layout fixes: safe areas around notches and system bars, the
  logged-out landing screen, and a screen that could get stuck loading.

## [0.2.1] - 2026-06-22

Push notifications are now on by default — once you allow notifications, Armada
keeps them enabled automatically across reloads and devices, so you don't have
to turn them back on.

## [0.2.0] - 2026-06-22

The desktop app is now a true standalone client — it isn't tied to any single
server. Add whatever servers you want; nothing is baked in. It also gains a
system tray (close to tray, an unread badge, and launch-minimized) and screen
sharing on desktop.

### Added
- Standalone desktop app: a fresh install starts with no servers and a welcome
  screen to log in and add your own — your client, your servers.
- System tray on desktop: closing the window keeps Armada running in the tray,
  with a Show/Quit menu, an unread badge, and the option to launch minimized.

### Fixed
- Screen sharing now works in the desktop app, with a picker to choose which
  screen or window to share.

## [0.1.2] - 2026-06-22

A maintenance release fixing the Windows desktop build image in CI. No
user-facing changes.

## [0.1.1] - 2026-06-22

A maintenance release that gets the desktop (Linux/Windows) installers building
in CI. No user-facing changes.

## [0.1.0] - 2026-06-22

The first tagged release of Armada — a sovereign harbor on the open relays, with
servers, channels, and voice. This release brings push notifications and native
desktop apps alongside the existing mobile app, so you stay reachable wherever
you are.

### Added
- Push notifications for messages, mentions, replies, reactions, and direct
  messages — delivered straight from your own server, so you get pinged even
  when Armada is closed. Choose exactly what you're notified about in Settings,
  Discord-style.
- Desktop apps for Linux and Windows (with a manual macOS build), published
  alongside the Android app on every release.
- End-to-end-encrypted voice for Concord communities, plus a redesigned in-call
  stage: screen sharing with a focus/spotlight mode and a theater layout.
