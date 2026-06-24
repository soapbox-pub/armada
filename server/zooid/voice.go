package zooid

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"

	"fiatjaf.com/nostr"
	"github.com/livekit/protocol/auth"
)

// Armada voice extensions ported onto zooid:
//
//   - Concord "blind broker": a community-agnostic LiveKit token endpoint for
//     serverless, end-to-end-encrypted Concord communities. Authority is key
//     possession (the grant is signed by the key whose x-only pubkey IS the
//     room name); the relay never learns the community or its membership.
//
//   - DM voice: 1:1 voice rooms that are not NIP-29 groups; the room id encodes
//     the two participant pubkeys and authorization is "the NIP-98 caller is one
//     of the two".
//
// Both reuse the per-instance LiveKit credentials from the relay config and the
// shared anti-replay + rate-limit helpers in voice_util.go.

// requestURL reconstructs the absolute URL the client addressed, matching the
// scheme/host/path the NIP-98 (or Concord) grant's `u` tag must echo. Mirrors
// the derivation in validateNIP98Auth.
func requestURL(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
		scheme = "https"
	}
	return fmt.Sprintf("%s://%s%s", scheme, r.Host, r.URL.Path)
}

// generateLivekitTokenForIdentity mints a join token for an arbitrary identity
// string (Concord identities are not pubkey-prefixed, so we can't reuse
// generateLivekitToken which derives identity from a nostr.PubKey).
func generateLivekitTokenForIdentity(apiKey, apiSecret, room, identity string) (string, error) {
	at := auth.NewAccessToken(apiKey, apiSecret)
	at.SetVideoGrant(&auth.VideoGrant{
		RoomJoin: true,
		Room:     room,
	})
	at.SetIdentity(identity)
	return at.ToJWT()
}

// ── DM voice ─────────────────────────────────────────────────────────────────

// parseDMRoomID validates a DM voice room id of the form
// "dm:<pubkeyA>:<pubkeyB>" where both are 64-char lowercase hex pubkeys sorted
// ascending. The canonical (sorted) form means both peers derive the same room
// id, so a caller is authorized simply by membership in the pair.
func parseDMRoomID(roomId string) (a, b string, ok bool) {
	rest, found := strings.CutPrefix(roomId, "dm:")
	if !found {
		return "", "", false
	}
	parts := strings.Split(rest, ":")
	if len(parts) != 2 {
		return "", "", false
	}
	a, b = parts[0], parts[1]
	if !isHex64(a) || !isHex64(b) {
		return "", "", false
	}
	if a >= b {
		return "", "", false
	}
	return a, b, true
}

func (instance *Instance) livekitDMTokenHandler(w http.ResponseWriter, r *http.Request) {
	voiceCORS(w)
	if r.Method == http.MethodOptions {
		return
	}

	cfg := instance.Config.Livekit
	if cfg.APIKey == "" {
		http.NotFound(w, r)
		return
	}

	roomId := strings.TrimPrefix(r.URL.Path, "/.well-known/nip29/livekit-dm/")
	a, b, ok := parseDMRoomID(roomId)
	if !ok {
		http.Error(w, "invalid dm room id", http.StatusBadRequest)
		return
	}

	pubkey, err := validateNIP98Auth(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusUnauthorized)
		return
	}

	hexpk := pubkey.Hex()
	if hexpk != a && hexpk != b {
		http.Error(w, "restricted: not a participant of this conversation", http.StatusForbidden)
		return
	}

	if !instance.Management.IsMember(pubkey) {
		http.Error(w, "not a member of this relay", http.StatusForbidden)
		return
	}

	suffix, err := randHex(4)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	identity := hexpk + "-" + suffix

	jwt, err := generateLivekitTokenForIdentity(cfg.APIKey, cfg.APISecret, roomId, identity)
	if err != nil {
		log.Printf("[livekit-dm] failed to mint token: %v", err)
		http.Error(w, "failed to mint token", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(TokenEndpointResponse{
		ServerURL:        cfg.ServerURL,
		ParticipantToken: jwt,
	})
}

// ── Concord blind broker ─────────────────────────────────────────────────────

func (instance *Instance) concordVoiceCapabilityHandler(w http.ResponseWriter, r *http.Request) {
	voiceCORS(w)
	if r.Method == http.MethodOptions {
		return
	}
	cfg := instance.Config.Livekit
	if cfg.APIKey == "" {
		http.NotFound(w, r)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// verifyVoiceGrant validates the `Authorization: Concord <base64-event>` grant
// for the given room. The grant is a kind-27235 event self-signed by the
// room-name key; we verify it was signed by exactly that key (pubkey == room),
// is fresh, and targets this endpoint. Authorization is "the signer holds the
// channel key", proven by the signature — no community lookup.
func verifyVoiceGrant(r *http.Request, room, expectedURL string) bool {
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Concord ") {
		return false
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(header, "Concord "))
	if err != nil {
		return false
	}
	var event nostr.Event
	if err := json.Unmarshal(raw, &event); err != nil {
		return false
	}
	if event.Kind != nostr.KindHTTPAuth {
		return false
	}
	// The binding: the grant must be signed by the key whose x-only pubkey is
	// the room name. This is the whole authorization model.
	if event.PubKey.Hex() != room {
		return false
	}
	if !event.VerifySignature() {
		return false
	}
	now := nostr.Now()
	if event.CreatedAt < now-60 || event.CreatedAt > now+60 {
		return false
	}
	uTag := event.Tags.Find("u")
	if uTag == nil || uTag[1] != expectedURL {
		return false
	}
	if methodTag := event.Tags.Find("method"); methodTag != nil && !strings.EqualFold(methodTag[1], r.Method) {
		return false
	}
	if roomTag := event.Tags.Find("room"); roomTag != nil && roomTag[1] != room {
		return false
	}
	// Single-use: reject a grant whose computed id we've already honored within
	// its freshness window (anti-replay). Checked last so we only consume the id
	// for an otherwise-valid grant.
	if rememberGrant(event.GetID().Hex()) {
		return false
	}
	return true
}

func (instance *Instance) concordVoiceTokenHandler(w http.ResponseWriter, r *http.Request) {
	voiceCORS(w)
	if r.Method == http.MethodOptions {
		return
	}

	cfg := instance.Config.Livekit
	if cfg.APIKey == "" {
		http.NotFound(w, r)
		return
	}

	room := strings.TrimPrefix(r.URL.Path, "/.well-known/concord/voice/")
	if !isHex64(room) {
		http.Error(w, "invalid room", http.StatusBadRequest)
		return
	}

	if !verifyVoiceGrant(r, room, requestURL(r)) {
		http.Error(w, "invalid voice grant", http.StatusUnauthorized)
		return
	}

	// LiveKit participant identity: the user's real pubkey (display only, from
	// an untrusted header — the broker does NOT gate on it) plus a random
	// suffix so the same person can join from multiple devices. If the header
	// is missing/malformed, fall back to a fully random identity.
	display := r.Header.Get("X-Concord-Identity")
	if !isHex64(display) {
		display = ""
	}
	suffix, err := randHex(8)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	identity := suffix
	if display != "" {
		identity = display + "-" + suffix
	}

	jwt, err := generateLivekitTokenForIdentity(cfg.APIKey, cfg.APISecret, room, identity)
	if err != nil {
		log.Printf("[concord] failed to mint token: %v", err)
		http.Error(w, "failed to mint token", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"token": jwt,
		"url":   cfg.ServerURL,
	})
}
