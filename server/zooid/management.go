package zooid

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strconv"

	"fiatjaf.com/nostr"
	"fiatjaf.com/nostr/khatru"
	"fiatjaf.com/nostr/nip86"
)

// Management store takes care of all nip 86 methods, as well as defining actions for internal use.
//
// The banned pubkeys list is a NIP 78 application-specific event, which keeps track of which pubkeys
// have been banned, independently of the members list. Banned events works the same way.
//
// Membership is implemented as defined here https://github.com/nostr-protocol/nips/pull/1079/files, using
// both membership lists and add/remove events.
//
// Actions like BanPubkey and AllowPubkey synchronize ban and membership lists. These should be called in most
// cases, unless you're trying to do something more advanced.
//
// All actions are idempotent, and won't do anything if conditions are already correct.

type ManagementStore struct {
	Config *Config
	Events *EventStore
}

// Banned events

func (m *ManagementStore) GetBannedEventItems() []nip86.IDReason {
	items := make([]nip86.IDReason, 0)
	for tag := range m.Events.GetOrCreateApplicationSpecificData(BANNED_EVENTS).Tags.FindAll("event") {
		if id, err := nostr.IDFromHex(tag[1]); err == nil {
			items = append(items, nip86.IDReason{
				ID:     id,
				Reason: tag[2],
			})
		}
	}

	return items
}

func (m *ManagementStore) BanEvent(id nostr.ID, reason string) error {
	if err := m.Events.DeleteEvent(id); err != nil {
		return err
	}

	event := m.Events.GetOrCreateApplicationSpecificData(BANNED_EVENTS)
	event.CreatedAt = nostr.Now()
	event.Tags = append(event.Tags, nostr.Tag{"event", id.Hex(), reason})

	return m.Events.SignAndStoreEvent(&event, false)
}

func (m *ManagementStore) AllowEvent(id nostr.ID, reason string) error {
	event := m.Events.GetOrCreateApplicationSpecificData(BANNED_EVENTS)
	event.CreatedAt = nostr.Now()
	event.Tags = Filter(event.Tags, func(t nostr.Tag) bool {
		return t[1] != id.Hex()
	})

	return m.Events.SignAndStoreEvent(&event, false)
}

func (m *ManagementStore) EventIsBanned(id nostr.ID) bool {
	event := m.Events.GetOrCreateApplicationSpecificData(BANNED_EVENTS)
	tag := event.Tags.FindWithValue("event", id.Hex())

	return tag != nil
}

// Internal banned pubkeys list

func (m *ManagementStore) GetBannedPubkeyItems() []nip86.PubKeyReason {
	event := m.Events.GetOrCreateApplicationSpecificData(BANNED_PUBKEYS)

	items := make([]nip86.PubKeyReason, 0)
	for tag := range event.Tags.FindAll("banned") {
		items = append(items, nip86.PubKeyReason{
			PubKey: nostr.MustPubKeyFromHex(tag[1]),
			Reason: tag[2],
		})
	}

	return items
}

func (m *ManagementStore) AddBannedPubkey(pubkey nostr.PubKey, reason string) error {
	event := m.Events.GetOrCreateApplicationSpecificData(BANNED_PUBKEYS)

	if event.Tags.FindWithValue("banned", pubkey.Hex()) == nil {
		event.CreatedAt = nostr.Now()
		event.Tags = append(event.Tags, nostr.Tag{"banned", pubkey.Hex(), reason})

		if err := m.Events.SignAndStoreEvent(&event, false); err != nil {
			return err
		}
	}

	return nil
}

func (m *ManagementStore) RemoveBannedPubkey(pubkey nostr.PubKey) error {
	event := m.Events.GetOrCreateApplicationSpecificData(BANNED_PUBKEYS)

	if event.Tags.FindWithValue("banned", pubkey.Hex()) != nil {
		event.CreatedAt = nostr.Now()
		event.Tags = Filter(event.Tags, func(t nostr.Tag) bool {
			return len(t) >= 2 && t[1] != pubkey.Hex()
		})

		if err := m.Events.SignAndStoreEvent(&event, false); err != nil {
			return err
		}
	}

	return nil
}

func (m *ManagementStore) PubkeyIsBanned(pubkey nostr.PubKey) bool {
	event := m.Events.GetOrCreateApplicationSpecificData(BANNED_PUBKEYS)
	tag := event.Tags.FindWithValue("banned", pubkey.Hex())

	return tag != nil
}

// Admins

func (m *ManagementStore) GetAdmins() []nostr.PubKey {
	members := make([]nostr.PubKey, 0)

	members = append(members, m.Config.GetOwner())

	for _, role := range m.Config.Roles {
		if role.CanManage {
			for _, pubkey := range role.Pubkeys {
				members = append(members, nostr.MustPubKeyFromHex(pubkey))
			}
		}
	}

	return members
}

func (m *ManagementStore) IsAdmin(pubkey nostr.PubKey) bool {
	return slices.Contains(m.GetAdmins(), pubkey)
}

// Membership

func (m *ManagementStore) GetMembers() []nostr.PubKey {
	pubkeys := make([]nostr.PubKey, 0)
	for tag := range m.Events.GetOrCreateRelayMembersList().Tags.FindAll("member") {
		pubkey, err := nostr.PubKeyFromHex(tag[1])

		if err == nil {
			pubkeys = append(pubkeys, pubkey)
		}
	}

	return pubkeys
}

func (m *ManagementStore) IsMember(pubkey nostr.PubKey) bool {
	return m.Events.GetOrCreateRelayMembersList().Tags.FindWithValue("member", pubkey.Hex()) != nil
}

func (m *ManagementStore) AddMember(pubkey nostr.PubKey) error {
	membersEvent := m.Events.GetOrCreateRelayMembersList()

	if membersEvent.Tags.FindWithValue("member", pubkey.Hex()) == nil {
		addMemberEvent := nostr.Event{
			Kind:      RELAY_ADD_MEMBER,
			CreatedAt: nostr.Now(),
			Tags: nostr.Tags{
				[]string{"-"},
				[]string{"p", pubkey.Hex()},
			},
		}

		if err := m.Events.SignAndStoreEvent(&addMemberEvent, true); err != nil {
			return err
		}

		membersEvent.CreatedAt = nostr.Now()
		membersEvent.Tags = append(membersEvent.Tags, nostr.Tag{"member", pubkey.Hex()})

		if err := m.Events.SignAndStoreEvent(&membersEvent, true); err != nil {
			return err
		}
	}

	return nil
}

func (m *ManagementStore) RemoveMember(pubkey nostr.PubKey) error {
	if m.IsAdmin(pubkey) {
		return errors.New("Can't remove permanent admins from relay.")
	}

	membersEvent := m.Events.GetOrCreateRelayMembersList()

	if membersEvent.Tags.FindWithValue("member", pubkey.Hex()) != nil {
		removeMemberEvent := nostr.Event{
			Kind:      RELAY_REMOVE_MEMBER,
			CreatedAt: nostr.Now(),
			Tags: nostr.Tags{
				[]string{"-"},
				[]string{"p", pubkey.Hex()},
			},
		}

		if err := m.Events.SignAndStoreEvent(&removeMemberEvent, true); err != nil {
			return err
		}

		membersEvent.CreatedAt = nostr.Now()
		membersEvent.Tags = Filter(membersEvent.Tags, func(t nostr.Tag) bool {
			return len(t) >= 2 && t[1] != pubkey.Hex()
		})

		if err := m.Events.SignAndStoreEvent(&membersEvent, true); err != nil {
			return err
		}

	}

	return nil
}

// Roles

func (m *ManagementStore) GetRoleDefinition(id string) (nostr.Event, bool) {
	filter := nostr.Filter{
		Kinds: []nostr.Kind{RELAY_ROLE},
		Tags:  nostr.TagMap{"d": []string{id}},
	}

	for event := range m.Events.QueryEvents(filter, 1) {
		return event, true
	}

	return nostr.Event{}, false
}

func (m *ManagementStore) buildRoleEvent(id, label, description string, color, order int) (nostr.Event, error) {
	if id == "" {
		return nostr.Event{}, errors.New("role id is required")
	}

	if color < 0 || color > 255 {
		return nostr.Event{}, errors.New("color must be a hue between 0 and 255")
	}

	tags := nostr.Tags{
		nostr.Tag{"-"},
		nostr.Tag{"d", id},
	}

	if label != "" {
		tags = append(tags, nostr.Tag{"label", label})
	}

	if description != "" {
		tags = append(tags, nostr.Tag{"description", description})
	}

	// color and order are optional integers. The nip86 layer can't distinguish an omitted
	// value from a zero, so we only persist them when they're explicitly non-zero, letting
	// clients fall back to their own defaults otherwise.
	if color != 0 {
		tags = append(tags, nostr.Tag{"color", strconv.Itoa(color)})
	}

	if order != 0 {
		tags = append(tags, nostr.Tag{"order", strconv.Itoa(order)})
	}

	return nostr.Event{
		Kind:      RELAY_ROLE,
		CreatedAt: nostr.Now(),
		Tags:      tags,
	}, nil
}

func (m *ManagementStore) CreateRole(id, label, description string, color, order int) error {
	if _, exists := m.GetRoleDefinition(id); exists {
		return fmt.Errorf("role %q already exists", id)
	}

	event, err := m.buildRoleEvent(id, label, description, color, order)
	if err != nil {
		return err
	}

	return m.Events.SignAndStoreEvent(&event, true)
}

func (m *ManagementStore) EditRole(id, label, description string, color, order int) error {
	if _, exists := m.GetRoleDefinition(id); !exists {
		return fmt.Errorf("role %q does not exist", id)
	}

	event, err := m.buildRoleEvent(id, label, description, color, order)
	if err != nil {
		return err
	}

	return m.Events.SignAndStoreEvent(&event, true)
}

func (m *ManagementStore) DeleteRole(id string) error {
	if event, exists := m.GetRoleDefinition(id); exists {
		if err := m.Events.DeleteEvent(event.ID); err != nil {
			return err
		}

		address := nostr.EntityPointer{
			Kind:       event.Kind,
			PublicKey:  event.PubKey,
			Identifier: event.Tags.GetD(),
		}.AsTagReference()

		event := nostr.Event{
			Kind:      nostr.KindDeletion,
			CreatedAt: nostr.Now(),
			Tags: nostr.Tags{
				nostr.Tag{"e", event.ID.Hex()},
				nostr.Tag{"a", address},
				nostr.Tag{"k", strconv.Itoa(int(event.Kind))},
			},
		}

		if err := m.Events.SignAndStoreEvent(&event, true); err != nil {
			return err
		}
	}

	return m.removeRoleFromMembers(id)
}

// Role assignment

func (m *ManagementStore) GetAssignedRoles(pubkey nostr.PubKey) []string {
	tag := m.Events.GetOrCreateRelayMembersList().Tags.FindWithValue("member", pubkey.Hex())

	if len(tag) < 3 {
		return []string{}
	}

	return slices.Clone(tag[2:])
}

func (m *ManagementStore) AssignRole(pubkey nostr.PubKey, roleID string) error {
	if _, exists := m.GetRoleDefinition(roleID); !exists {
		return fmt.Errorf("role %q does not exist", roleID)
	}

	// A role is meaningless without membership, so ensure the pubkey is a member first.
	if err := m.AddMember(pubkey); err != nil {
		return err
	}

	roles := m.GetAssignedRoles(pubkey)

	if slices.Contains(roles, roleID) {
		return nil
	}

	return m.setAssignedRoles(pubkey, append(roles, roleID))
}

func (m *ManagementStore) UnassignRole(pubkey nostr.PubKey, roleID string) error {
	roles := m.GetAssignedRoles(pubkey)

	if !slices.Contains(roles, roleID) {
		return nil
	}

	return m.setAssignedRoles(pubkey, Remove(roles, roleID))
}

func (m *ManagementStore) setAssignedRoles(pubkey nostr.PubKey, roleIDs []string) error {
	membersEvent := m.Events.GetOrCreateRelayMembersList()

	found := false
	tags := make(nostr.Tags, 0, len(membersEvent.Tags))
	for _, tag := range membersEvent.Tags {
		if len(tag) >= 2 && tag[0] == "member" && tag[1] == pubkey.Hex() {
			found = true
			tags = append(tags, append(nostr.Tag{"member", pubkey.Hex()}, roleIDs...))
		} else {
			tags = append(tags, tag)
		}
	}

	if !found {
		return nil
	}

	membersEvent.CreatedAt = nostr.Now()
	membersEvent.Tags = tags

	return m.Events.SignAndStoreEvent(&membersEvent, true)
}

func (m *ManagementStore) removeRoleFromMembers(roleID string) error {
	membersEvent := m.Events.GetOrCreateRelayMembersList()

	changed := false
	tags := make(nostr.Tags, 0, len(membersEvent.Tags))
	for _, tag := range membersEvent.Tags {
		if len(tag) >= 3 && tag[0] == "member" && slices.Contains(tag[2:], roleID) {
			changed = true
			roles := Filter(tag[2:], func(r string) bool { return r != roleID })
			tags = append(tags, append(nostr.Tag{"member", tag[1]}, roles...))
		} else {
			tags = append(tags, tag)
		}
	}

	if !changed {
		return nil
	}

	membersEvent.CreatedAt = nostr.Now()
	membersEvent.Tags = tags

	return m.Events.SignAndStoreEvent(&membersEvent, true)
}

// Signing

// SignEvent signs an event template with the relay's identity key on an admin's behalf, then
// stores and broadcasts it before returning the signed event. Only kind 30078 (application-specific
// data) is supported for now; every other kind is rejected outright.
func (m *ManagementStore) SignEvent(kind nostr.Kind, createdAt nostr.Timestamp, tags nostr.Tags, content string) (nostr.Event, error) {
	if kind != nostr.KindApplicationSpecificData {
		return nostr.Event{}, errors.New("kind not allowed")
	}

	// A missing created_at would otherwise default to the epoch, which is almost never what
	// the caller intends, so fall back to the current time.
	if createdAt == 0 {
		createdAt = nostr.Now()
	}

	event := nostr.Event{
		Kind:      kind,
		CreatedAt: createdAt,
		Tags:      tags,
		Content:   content,
	}

	if err := m.Events.SignAndStoreEvent(&event, true); err != nil {
		return nostr.Event{}, err
	}

	return event, nil
}

// Banning

func (m *ManagementStore) BanPubkey(pubkey nostr.PubKey, reason string) error {
	if err := m.RemoveMember(pubkey); err != nil {
		return err
	}

	if err := m.AddBannedPubkey(pubkey, reason); err != nil {
		return err
	}

	filter := nostr.Filter{
		Authors: []nostr.PubKey{pubkey},
	}

	for event := range m.Events.QueryEvents(filter, 0) {
		m.Events.DeleteEvent(event.ID)
	}

	return nil
}

func (m *ManagementStore) UnbanPubkey(pubkey nostr.PubKey, reason string) error {
	return m.RemoveBannedPubkey(pubkey)
}

// Allowing

func (m *ManagementStore) GetAllowedPubkeyItems() []nip86.PubKeyReason {
	reasons := make([]nip86.PubKeyReason, 0)
	for _, pubkey := range m.GetMembers() {
		reasons = append(
			reasons,
			nip86.PubKeyReason{
				PubKey: pubkey,
				Reason: "relay member",
			},
		)
	}

	return reasons
}

func (m *ManagementStore) AllowPubkey(pubkey nostr.PubKey) error {
	if err := m.AddMember(pubkey); err != nil {
		return err
	}

	if err := m.RemoveBannedPubkey(pubkey); err != nil {
		return err
	}

	return nil
}

func (m *ManagementStore) UnallowPubkey(pubkey nostr.PubKey, reason string) error {
	return m.RemoveMember(pubkey)
}

// Joining

func (m *ManagementStore) ValidateJoinRequest(event nostr.Event) (reject bool, err string) {
	if m.IsMember(event.PubKey) {
		return false, ""
	}

	if m.PubkeyIsBanned(event.PubKey) {
		return true, "invalid: you have been banned from this relay"
	}

	if m.Config.Policy.PublicJoin {
		return false, ""
	}

	claimTag := event.Tags.Find("claim")

	if claimTag == nil {
		return true, "invalid: no claim tag"
	}

	filter := nostr.Filter{
		Kinds: []nostr.Kind{RELAY_INVITE},
	}

	for event := range m.Events.QueryEvents(filter, 0) {
		if event.Tags.FindWithValue("claim", claimTag[1]) != nil {
			return false, ""
		}
	}

	return true, "invalid: failed to validate invite code"
}

// Middleware

func (m *ManagementStore) Enable(instance *Instance) {
	instance.Relay.ManagementAPI.OnAPICall = func(ctx context.Context, mp nip86.MethodParams) (reject bool, msg string) {
		pubkey, ok := khatru.GetAuthed(ctx)

		if !ok {
			return true, "blocked: please authenticate in order to manage this relay"
		}

		if !m.Config.CanManage(pubkey) {
			return true, "blocked: only relay admins can manage this relay."
		}

		return false, ""
	}

	instance.Relay.ManagementAPI.ChangeRelayName = func(ctx context.Context, name string) error {
		return m.Config.SetName(name)
	}
	instance.Relay.ManagementAPI.ChangeRelayDescription = func(ctx context.Context, desc string) error {
		return m.Config.SetDescription(desc)
	}
	instance.Relay.ManagementAPI.ChangeRelayIcon = func(ctx context.Context, icon string) error {
		return m.Config.SetIcon(icon)
	}

	instance.Relay.ManagementAPI.BanPubKey = func(ctx context.Context, pubkey nostr.PubKey, reason string) error {
		return m.BanPubkey(pubkey, reason)
	}

	instance.Relay.ManagementAPI.UnbanPubKey = func(ctx context.Context, pubkey nostr.PubKey, reason string) error {
		return m.UnbanPubkey(pubkey, reason)
	}

	instance.Relay.ManagementAPI.AllowPubKey = func(ctx context.Context, pubkey nostr.PubKey, reason string) error {
		return m.AllowPubkey(pubkey)
	}

	instance.Relay.ManagementAPI.UnallowPubKey = func(ctx context.Context, pubkey nostr.PubKey, reason string) error {
		return m.UnallowPubkey(pubkey, reason)
	}

	instance.Relay.ManagementAPI.ListBannedPubKeys = func(ctx context.Context) ([]nip86.PubKeyReason, error) {
		return m.GetBannedPubkeyItems(), nil
	}

	instance.Relay.ManagementAPI.ListAllowedPubKeys = func(ctx context.Context) ([]nip86.PubKeyReason, error) {
		return m.GetAllowedPubkeyItems(), nil
	}

	instance.Relay.ManagementAPI.BanEvent = func(ctx context.Context, id nostr.ID, reason string) error {
		return m.BanEvent(id, reason)
	}

	instance.Relay.ManagementAPI.AllowEvent = func(ctx context.Context, id nostr.ID, reason string) error {
		return m.AllowEvent(id, reason)
	}

	instance.Relay.ManagementAPI.ListBannedEvents = func(ctx context.Context) ([]nip86.IDReason, error) {
		return m.GetBannedEventItems(), nil
	}

	instance.Relay.ManagementAPI.CreateRole = func(ctx context.Context, id, label, description string, color, order int) error {
		return m.CreateRole(id, label, description, color, order)
	}

	instance.Relay.ManagementAPI.EditRole = func(ctx context.Context, id, label, description string, color, order int) error {
		return m.EditRole(id, label, description, color, order)
	}

	instance.Relay.ManagementAPI.DeleteRole = func(ctx context.Context, id string) error {
		return m.DeleteRole(id)
	}

	instance.Relay.ManagementAPI.AssignRole = func(ctx context.Context, pubkey nostr.PubKey, roleID string) error {
		return m.AssignRole(pubkey, roleID)
	}

	instance.Relay.ManagementAPI.UnassignRole = func(ctx context.Context, pubkey nostr.PubKey, roleID string) error {
		return m.UnassignRole(pubkey, roleID)
	}

	instance.Relay.ManagementAPI.SignEvent = func(ctx context.Context, kind nostr.Kind, createdAt nostr.Timestamp, tags nostr.Tags, content string) (nostr.Event, error) {
		return m.SignEvent(kind, createdAt, tags, content)
	}
}
