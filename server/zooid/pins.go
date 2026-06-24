package zooid

import (
	"fiatjaf.com/nostr"
)

// KindGroupPins is the Armada extension kind carrying a group's set of pinned
// messages: an addressable event (`d` = group id) with one `e` tag per pinned
// message. It is NOT part of NIP-29 proper. Only the relay itself or a group
// admin/manager may write it; the newest such event is authoritative.
const KindGroupPins nostr.Kind = 39041

// checkPinWrite gates writes of the pinned-messages event (kind 39041) to a
// group's admins/managers. Returns a non-empty rejection reason when the write
// must be blocked. Membership is already enforced upstream in OnEvent; this adds
// the role gate so a regular member can't pin or unpin.
func (instance *Instance) checkPinWrite(event nostr.Event) string {
	if event.Kind != KindGroupPins {
		return ""
	}

	// The relay's own key may always write (internal automation).
	if instance.Config.IsSelf(event.PubKey) {
		return ""
	}

	groupId := ""
	if t := event.Tags.Find("h"); t != nil {
		groupId = t[1]
	}
	if groupId == "" {
		return "invalid: pinned-messages event missing group (`h`) tag"
	}

	// The `d` tag must match the group so the addressable event is keyed
	// per-group and can't masquerade under another group's coordinate.
	if t := event.Tags.Find("d"); t == nil || t[1] != groupId {
		return "invalid: pinned-messages `d` tag must equal the group id"
	}

	if _, found := instance.Groups.GetMetadata(groupId); !found {
		return "invalid: group not found"
	}

	// Admins/managers only: relay managers (NIP-86 CanManage) or group admins.
	if instance.Config.CanManage(event.PubKey) || instance.Groups.IsAdmin(groupId, event.PubKey) {
		return ""
	}

	return "restricted: only admins or moderators may pin messages"
}
