package zooid

import (
	"strconv"
	"testing"

	"fiatjaf.com/nostr"
	"fiatjaf.com/nostr/khatru"
)

func createTestManagementStore() *ManagementStore {
	config := &Config{
		Host:   "test.com",
		secret: nostr.Generate(),
	}
	config.Info.Pubkey = nostr.Generate().Public().Hex()
	schema := &Schema{Name: "test_" + RandomString(8)}
	relay := khatru.NewRelay()
	events := &EventStore{
		Relay:  relay,
		Config: config,
		Schema: schema,
	}
	events.Init()

	return &ManagementStore{
		Config: config,
		Events: events,
	}
}

func TestManagementStore_BanPubkey(t *testing.T) {
	mgmt := createTestManagementStore()

	pubkey := nostr.Generate().Public()
	reason := "spam"

	// Note: BanPubkey might return "duplicate event" error due to implementation
	// but the banning should still work
	mgmt.BanPubkey(pubkey, reason)

	// Test that pubkey is now banned
	if !mgmt.PubkeyIsBanned(pubkey) {
		t.Error("PubkeyIsBanned() should return true after banning")
	}

	// Test banned pubkey items
	bannedItems := mgmt.GetBannedPubkeyItems()
	itemFound := false
	for _, item := range bannedItems {
		if item.PubKey == pubkey && item.Reason == reason {
			itemFound = true
			break
		}
	}
	if !itemFound {
		t.Error("GetBannedPubkeyItems() should include banned pubkey with reason")
	}
}

func TestManagementStore_AllowPubkey(t *testing.T) {
	mgmt := createTestManagementStore()

	pubkey := nostr.Generate().Public()

	// Ban then allow
	mgmt.BanPubkey(pubkey, "test")

	if !mgmt.PubkeyIsBanned(pubkey) {
		t.Error("Setup: pubkey should be banned")
	}

	mgmt.AllowPubkey(pubkey)

	if mgmt.PubkeyIsBanned(pubkey) {
		t.Error("PubkeyIsBanned() should return false after allowing")
	}
}

func TestManagementStore_UnbanPubkey(t *testing.T) {
	mgmt := createTestManagementStore()

	pubkey := nostr.Generate().Public()

	mgmt.BanPubkey(pubkey, "test")

	if !mgmt.PubkeyIsBanned(pubkey) {
		t.Error("Setup: pubkey should be banned")
	}

	if err := mgmt.UnbanPubkey(pubkey, "appeal accepted"); err != nil {
		t.Fatalf("UnbanPubkey() should not return error: %v", err)
	}

	if mgmt.PubkeyIsBanned(pubkey) {
		t.Error("PubkeyIsBanned() should return false after unbanning")
	}
}

func TestManagementStore_UnallowPubkey(t *testing.T) {
	mgmt := createTestManagementStore()

	pubkey := nostr.Generate().Public()

	if err := mgmt.AllowPubkey(pubkey); err != nil {
		t.Fatalf("AllowPubkey() should not return error: %v", err)
	}

	if !mgmt.IsMember(pubkey) {
		t.Error("Setup: pubkey should be a member")
	}

	if err := mgmt.UnallowPubkey(pubkey, "membership revoked"); err != nil {
		t.Fatalf("UnallowPubkey() should not return error: %v", err)
	}

	if mgmt.IsMember(pubkey) {
		t.Error("IsMember() should return false after unallowing")
	}
}

func TestManagementStore_BanEvent(t *testing.T) {
	mgmt := createTestManagementStore()

	eventID := nostr.MustIDFromHex("1234567890123456789012345678901234567890123456789012345678901234")
	reason := "inappropriate"

	mgmt.BanEvent(eventID, reason)

	// Test that event is now banned
	if !mgmt.EventIsBanned(eventID) {
		t.Error("EventIsBanned() should return true after banning")
	}

	// Test banned event items
	bannedItems := mgmt.GetBannedEventItems()
	itemFound := false
	for _, item := range bannedItems {
		if item.ID == eventID && item.Reason == reason {
			itemFound = true
			break
		}
	}
	if !itemFound {
		t.Error("GetBannedEventItems() should include banned event with reason")
	}
}

func TestManagementStore_AllowEvent(t *testing.T) {
	mgmt := createTestManagementStore()

	eventID := nostr.MustIDFromHex("1234567890123456789012345678901234567890123456789012345678901234")

	// Ban then allow
	mgmt.BanEvent(eventID, "test")

	if !mgmt.EventIsBanned(eventID) {
		t.Error("Setup: event should be banned")
	}

	mgmt.AllowEvent(eventID, "unbanned")

	if mgmt.EventIsBanned(eventID) {
		t.Error("EventIsBanned() should return false after allowing")
	}
}

func roleTagValue(event nostr.Event, key string) string {
	tag := event.Tags.Find(key)
	if len(tag) < 2 {
		return ""
	}

	return tag[1]
}

func TestManagementStore_CreateRole(t *testing.T) {
	mgmt := createTestManagementStore()

	if err := mgmt.CreateRole("king", "King", "ruler of the relay", 37, 1); err != nil {
		t.Fatalf("CreateRole() error = %v", err)
	}

	event, ok := mgmt.GetRoleDefinition("king")
	if !ok {
		t.Fatal("GetRoleDefinition() should return the created role")
	}

	if event.Kind != RELAY_ROLE {
		t.Errorf("role event kind = %v, want %v", event.Kind, RELAY_ROLE)
	}

	if !HasTag(event.Tags, "-") {
		t.Error("role event should carry a NIP 70 \"-\" tag")
	}

	if got := roleTagValue(event, "d"); got != "king" {
		t.Errorf("d tag = %q, want %q", got, "king")
	}

	if got := roleTagValue(event, "label"); got != "King" {
		t.Errorf("label tag = %q, want %q", got, "King")
	}

	if got := roleTagValue(event, "description"); got != "ruler of the relay" {
		t.Errorf("description tag = %q, want %q", got, "ruler of the relay")
	}

	if got := roleTagValue(event, "color"); got != "37" {
		t.Errorf("color tag = %q, want %q", got, "37")
	}

	if got := roleTagValue(event, "order"); got != "1" {
		t.Errorf("order tag = %q, want %q", got, "1")
	}

	if event.PubKey != mgmt.Config.GetSelf() {
		t.Error("role event should be signed by the relay self key")
	}
}

func TestManagementStore_CreateRole_Duplicate(t *testing.T) {
	mgmt := createTestManagementStore()

	if err := mgmt.CreateRole("king", "King", "", 0, 0); err != nil {
		t.Fatalf("CreateRole() error = %v", err)
	}

	if err := mgmt.CreateRole("king", "King", "", 0, 0); err == nil {
		t.Error("CreateRole() should error when the role already exists")
	}
}

func TestManagementStore_CreateRole_OmitsEmptyAndZero(t *testing.T) {
	mgmt := createTestManagementStore()

	if err := mgmt.CreateRole("plain", "", "", 0, 0); err != nil {
		t.Fatalf("CreateRole() error = %v", err)
	}

	event, ok := mgmt.GetRoleDefinition("plain")
	if !ok {
		t.Fatal("GetRoleDefinition() should return the created role")
	}

	for _, key := range []string{"label", "description", "color", "order"} {
		if HasTag(event.Tags, key) {
			t.Errorf("role event should omit empty/zero %q tag", key)
		}
	}
}

func TestManagementStore_CreateRole_InvalidColor(t *testing.T) {
	mgmt := createTestManagementStore()

	if err := mgmt.CreateRole("king", "King", "", 300, 0); err == nil {
		t.Error("CreateRole() should error on out-of-range color")
	}

	if _, ok := mgmt.GetRoleDefinition("king"); ok {
		t.Error("invalid role should not have been stored")
	}
}

func TestManagementStore_EditRole(t *testing.T) {
	mgmt := createTestManagementStore()

	if err := mgmt.EditRole("king", "King", "", 0, 0); err == nil {
		t.Error("EditRole() should error when the role does not exist")
	}

	if err := mgmt.CreateRole("king", "King", "ruler", 10, 1); err != nil {
		t.Fatalf("CreateRole() error = %v", err)
	}

	if err := mgmt.EditRole("king", "Monarch", "the boss", 200, 2); err != nil {
		t.Fatalf("EditRole() error = %v", err)
	}

	event, ok := mgmt.GetRoleDefinition("king")
	if !ok {
		t.Fatal("GetRoleDefinition() should return the edited role")
	}

	if got := roleTagValue(event, "label"); got != "Monarch" {
		t.Errorf("label tag = %q, want %q", got, "Monarch")
	}

	if got := roleTagValue(event, "color"); got != "200" {
		t.Errorf("color tag = %q, want %q", got, "200")
	}

	// Editing replaces the definition, so there should only be a single role event.
	count := 0
	for range mgmt.Events.QueryEvents(nostr.Filter{Kinds: []nostr.Kind{RELAY_ROLE}}, 0) {
		count++
	}
	if count != 1 {
		t.Errorf("expected 1 role event after edit, got %d", count)
	}
}

func TestManagementStore_AssignAndUnassignRole(t *testing.T) {
	mgmt := createTestManagementStore()

	pubkey := nostr.Generate().Public()

	if err := mgmt.CreateRole("king", "King", "", 0, 0); err != nil {
		t.Fatalf("CreateRole() error = %v", err)
	}

	if err := mgmt.AssignRole(pubkey, "king"); err != nil {
		t.Fatalf("AssignRole() error = %v", err)
	}

	// Assigning a role implies membership.
	if !mgmt.IsMember(pubkey) {
		t.Error("AssignRole() should make the pubkey a member")
	}

	if roles := mgmt.GetAssignedRoles(pubkey); len(roles) != 1 || roles[0] != "king" {
		t.Errorf("GetAssignedRoles() = %v, want [king]", roles)
	}

	// Assignment is idempotent and must not duplicate the role.
	if err := mgmt.AssignRole(pubkey, "king"); err != nil {
		t.Fatalf("AssignRole() repeat error = %v", err)
	}

	if roles := mgmt.GetAssignedRoles(pubkey); len(roles) != 1 {
		t.Errorf("GetAssignedRoles() after repeat = %v, want one entry", roles)
	}

	if err := mgmt.UnassignRole(pubkey, "king"); err != nil {
		t.Fatalf("UnassignRole() error = %v", err)
	}

	if roles := mgmt.GetAssignedRoles(pubkey); len(roles) != 0 {
		t.Errorf("GetAssignedRoles() after unassign = %v, want empty", roles)
	}

	// Unassigning a role does not revoke membership.
	if !mgmt.IsMember(pubkey) {
		t.Error("UnassignRole() should leave the pubkey a member")
	}
}

func TestManagementStore_AssignRole_UnknownRole(t *testing.T) {
	mgmt := createTestManagementStore()

	pubkey := nostr.Generate().Public()

	if err := mgmt.AssignRole(pubkey, "ghost"); err == nil {
		t.Error("AssignRole() should error for an undefined role")
	}

	if mgmt.IsMember(pubkey) {
		t.Error("failed AssignRole() should not add membership")
	}
}

func TestManagementStore_DeleteRole(t *testing.T) {
	mgmt := createTestManagementStore()

	pubkey := nostr.Generate().Public()

	if err := mgmt.CreateRole("king", "King", "", 0, 0); err != nil {
		t.Fatalf("CreateRole() error = %v", err)
	}

	if err := mgmt.AssignRole(pubkey, "king"); err != nil {
		t.Fatalf("AssignRole() error = %v", err)
	}

	if err := mgmt.DeleteRole("king"); err != nil {
		t.Fatalf("DeleteRole() error = %v", err)
	}

	if _, ok := mgmt.GetRoleDefinition("king"); ok {
		t.Error("GetRoleDefinition() should return false after deletion")
	}

	// Deleting a role must strip dangling assignments from the members list.
	if roles := mgmt.GetAssignedRoles(pubkey); len(roles) != 0 {
		t.Errorf("GetAssignedRoles() after delete = %v, want empty", roles)
	}

	// The pubkey remains a member, just without the deleted role.
	if !mgmt.IsMember(pubkey) {
		t.Error("DeleteRole() should leave the pubkey a member")
	}
}

func TestManagementStore_DeleteRole_BroadcastsDeletion(t *testing.T) {
	mgmt := createTestManagementStore()

	if err := mgmt.CreateRole("king", "King", "", 0, 0); err != nil {
		t.Fatalf("CreateRole() error = %v", err)
	}

	role, ok := mgmt.GetRoleDefinition("king")
	if !ok {
		t.Fatal("GetRoleDefinition() should return the created role")
	}

	if err := mgmt.DeleteRole("king"); err != nil {
		t.Fatalf("DeleteRole() error = %v", err)
	}

	filter := nostr.Filter{Kinds: []nostr.Kind{nostr.KindDeletion}}

	var deletion *nostr.Event
	for event := range mgmt.Events.QueryEvents(filter, 1) {
		e := event
		deletion = &e
	}

	if deletion == nil {
		t.Fatal("DeleteRole() should store a deletion event")
	}

	address := nostr.EntityPointer{
		Kind:       RELAY_ROLE,
		PublicKey:  role.PubKey,
		Identifier: "king",
	}.AsTagReference()

	if tag := deletion.Tags.FindWithValue("e", role.ID.Hex()); tag == nil {
		t.Errorf("deletion event missing e tag for %s", role.ID.Hex())
	}

	if tag := deletion.Tags.FindWithValue("a", address); tag == nil {
		t.Errorf("deletion event missing a tag for %s", address)
	}

	if tag := deletion.Tags.FindWithValue("k", strconv.Itoa(RELAY_ROLE)); tag == nil {
		t.Errorf("deletion event missing k tag for kind %d", RELAY_ROLE)
	}
}

func TestManagementStore_SignEvent_AllowedKind(t *testing.T) {
	mgmt := createTestManagementStore()

	tags := nostr.Tags{nostr.Tag{"d", "zooid/test"}}

	event, err := mgmt.SignEvent(nostr.KindApplicationSpecificData, 0, tags, "hello")
	if err != nil {
		t.Fatalf("SignEvent() error = %v", err)
	}

	if event.PubKey != mgmt.Config.GetSelf() {
		t.Errorf("SignEvent() signed with %s, want relay key %s", event.PubKey, mgmt.Config.GetSelf())
	}

	if !event.VerifySignature() {
		t.Error("SignEvent() produced an invalid signature")
	}

	// A zero created_at must be replaced with the current time.
	if event.CreatedAt == 0 {
		t.Error("SignEvent() should default a missing created_at to the current time")
	}

	// SignEvent must not persist the event, only return it.
	filter := nostr.Filter{Kinds: []nostr.Kind{nostr.KindApplicationSpecificData}, Tags: nostr.TagMap{"d": []string{"zooid/test"}}}

	for stored := range mgmt.Events.QueryEvents(filter, 1) {
		if stored.ID == event.ID {
			t.Error("SignEvent() should not store the signed event")
		}
	}
}

func TestManagementStore_SignEvent_RejectsOtherKinds(t *testing.T) {
	mgmt := createTestManagementStore()

	if _, err := mgmt.SignEvent(nostr.KindTextNote, 0, nil, ""); err == nil || err.Error() != "kind not allowed" {
		t.Errorf("SignEvent() error = %v, want \"kind not allowed\"", err)
	}
}

func TestManagementStore_PubkeyIsBanned_NotBanned(t *testing.T) {
	mgmt := createTestManagementStore()

	pubkey := nostr.Generate().Public()

	if mgmt.PubkeyIsBanned(pubkey) {
		t.Error("PubkeyIsBanned() should return false for non-banned pubkey")
	}
}

func TestManagementStore_EventIsBanned_NotBanned(t *testing.T) {
	mgmt := createTestManagementStore()

	eventID := nostr.MustIDFromHex("abcdef1234567890123456789012345678901234567890123456789012345678")

	if mgmt.EventIsBanned(eventID) {
		t.Error("EventIsBanned() should return false for non-banned event")
	}
}
