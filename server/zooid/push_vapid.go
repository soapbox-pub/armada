package zooid

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"fiatjaf.com/nostr"
	webpush "github.com/SherClockHolmes/webpush-go"
)

// Web Push (VAPID) notification gateway, ported from Armada's relay onto zooid
// and made multi-tenant: each virtual relay (Instance) has its own VAPID
// keypair and its own subscriptions, both stored in the shared kv namespaced by
// the relay's schema.
//
// HTTP surface (per host, NIP-98 authed where noted):
//
//	GET    /.well-known/armada/push          → 204 capability probe
//	GET    /.well-known/armada/push/vapid    → { "vapid_public_key": "<b64url>" }
//	PUT    /.well-known/armada/push          → register/update subscription (NIP-98)
//	DELETE /.well-known/armada/push          → remove subscription (NIP-98)
//
// The relay observes every saved event (Instance.OnEventSaved → FanOut) and, for
// chat (kind 9), reactions (7), threaded replies (1111) and DMs (4), pushes a
// notification to the relevant recipients' registered browser endpoints.

const (
	pushContentCap = 140
	pushTTLSeconds = 24 * 60 * 60
	pushSendBurst  = 50
)

type vapidKeys struct {
	PublicKey  string `json:"public_key"`
	PrivateKey string `json:"private_key"`
}

// pushPrefs are per-user notification preferences (Discord-style). All default
// to enabled (except AllGroupMessages) when absent.
type pushPrefs struct {
	Mentions         *bool `json:"mentions,omitempty"`
	Reactions        *bool `json:"reactions,omitempty"`
	Replies          *bool `json:"replies,omitempty"`
	DirectMessages   *bool `json:"direct_messages,omitempty"`
	AllGroupMessages *bool `json:"all_group_messages,omitempty"`
}

func prefEnabled(p *bool, dflt bool) bool {
	if p == nil {
		return dflt
	}
	return *p
}

type pushRecord struct {
	Pubkey       string               `json:"pubkey"`
	Subscription webpush.Subscription `json:"subscription"`
	Prefs        pushPrefs            `json:"prefs"`
	UpdatedAt    int64                `json:"updated_at"`
}

type VapidPushManager struct {
	instance *Instance
	kv       *KV
	vapid    vapidKeys
	mu       sync.RWMutex
	client   *http.Client
}

func NewVapidPushManager(instance *Instance) *VapidPushManager {
	p := &VapidPushManager{
		instance: instance,
		kv:       &KV{Name: "push:" + instance.Config.Schema},
		client:   &http.Client{Timeout: 10 * time.Second},
	}
	p.loadOrCreateVapid()
	return p
}

func (p *VapidPushManager) RegisterRoutes(router interface {
	HandleFunc(pattern string, handler func(http.ResponseWriter, *http.Request))
}) {
	router.HandleFunc("/.well-known/armada/push", pushLimiter.limit(p.handleSubscription))
	router.HandleFunc("/.well-known/armada/push/vapid", p.handleVapid)
}

// ── VAPID key management ─────────────────────────────────────────────────────

func (p *VapidPushManager) loadOrCreateVapid() {
	// Operator-pinned keys take precedence (shared across all tenants on this
	// process). Env is the source of truth and is not persisted.
	if pub, priv := Env("PUSH_VAPID_PUBLIC_KEY"), Env("PUSH_VAPID_PRIVATE_KEY"); pub != "" && priv != "" {
		p.vapid = vapidKeys{PublicKey: pub, PrivateKey: priv}
		return
	}

	if raw, err := p.kv.Get("vapid"); err == nil && raw != "" {
		var vk vapidKeys
		if json.Unmarshal([]byte(raw), &vk) == nil && vk.PublicKey != "" && vk.PrivateKey != "" {
			p.vapid = vk
			return
		}
	}

	priv, pub, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		log.Printf("[push] failed to generate VAPID keys for %s: %v", p.instance.Config.Schema, err)
		return
	}
	p.vapid = vapidKeys{PublicKey: pub, PrivateKey: priv}
	blob, _ := json.Marshal(p.vapid)
	if err := p.kv.Set("vapid", string(blob)); err != nil {
		log.Printf("[push] failed to persist VAPID keys for %s: %v", p.instance.Config.Schema, err)
	}
}

func (p *VapidPushManager) vapidSubject() string {
	return "https://" + p.instance.Config.Host
}

// ── HTTP handlers ────────────────────────────────────────────────────────────

func (p *VapidPushManager) handleVapid(w http.ResponseWriter, r *http.Request) {
	voiceCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if p.vapid.PublicKey == "" {
		http.Error(w, "push not configured", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"vapid_public_key": p.vapid.PublicKey})
}

type pushRegisterBody struct {
	Subscription webpush.Subscription `json:"subscription"`
	Prefs        pushPrefs            `json:"prefs"`
}

func (p *VapidPushManager) handleSubscription(w http.ResponseWriter, r *http.Request) {
	voiceCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method == http.MethodGet {
		w.WriteHeader(http.StatusNoContent) // capability probe
		return
	}
	if r.Method != http.MethodPut && r.Method != http.MethodDelete {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	pubkey, err := validateNIP98Auth(r)
	if err != nil {
		http.Error(w, "invalid NIP-98 authorization", http.StatusUnauthorized)
		return
	}
	hexpk := pubkey.Hex()

	body, err := io.ReadAll(io.LimitReader(r.Body, 8<<10))
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	if r.Method == http.MethodDelete {
		var req pushRegisterBody
		_ = json.Unmarshal(body, &req)
		if req.Subscription.Endpoint != "" {
			p.deleteRecord(hexpk, req.Subscription.Endpoint)
		} else {
			p.deleteAllRecords(hexpk)
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}

	var req pushRegisterBody
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}
	if req.Subscription.Endpoint == "" || req.Subscription.Keys.P256dh == "" || req.Subscription.Keys.Auth == "" {
		http.Error(w, "missing push subscription", http.StatusBadRequest)
		return
	}
	if !isSafePushEndpoint(req.Subscription.Endpoint) {
		http.Error(w, "invalid push endpoint", http.StatusBadRequest)
		return
	}

	rec := pushRecord{
		Pubkey:       hexpk,
		Subscription: req.Subscription,
		Prefs:        req.Prefs,
		UpdatedAt:    time.Now().Unix(),
	}
	if err := p.putRecord(rec); err != nil {
		log.Printf("[push] failed to persist subscription: %v", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ── Storage (kv, namespaced per tenant) ──────────────────────────────────────
//
// The kv is a flat key→value table, so we maintain a per-pubkey index value
// listing the endpoint hashes registered for that pubkey, and store each record
// under "sub:<pubkey>:<endpoint-hash>". This avoids needing prefix iteration.

func endpointHash(endpoint string) string {
	sum := sha256.Sum256([]byte(endpoint))
	return hex.EncodeToString(sum[:8])
}

func (p *VapidPushManager) indexKey(pubkey string) string { return "idx:" + pubkey }
func (p *VapidPushManager) recordKey(pubkey, h string) string {
	return "sub:" + pubkey + ":" + h
}

func (p *VapidPushManager) loadIndex(pubkey string) []string {
	raw, err := p.kv.Get(p.indexKey(pubkey))
	if err != nil || raw == "" {
		return nil
	}
	var hashes []string
	if json.Unmarshal([]byte(raw), &hashes) != nil {
		return nil
	}
	return hashes
}

func (p *VapidPushManager) saveIndex(pubkey string, hashes []string) {
	blob, _ := json.Marshal(hashes)
	_ = p.kv.Set(p.indexKey(pubkey), string(blob))
}

func (p *VapidPushManager) putRecord(rec pushRecord) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	h := endpointHash(rec.Subscription.Endpoint)
	blob, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	if err := p.kv.Set(p.recordKey(rec.Pubkey, h), string(blob)); err != nil {
		return err
	}
	hashes := p.loadIndex(rec.Pubkey)
	if !contains(hashes, h) {
		p.saveIndex(rec.Pubkey, append(hashes, h))
	}
	return nil
}

func (p *VapidPushManager) deleteRecord(pubkey, endpoint string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.deleteRecordLocked(pubkey, endpointHash(endpoint))
}

// deleteRecordLocked removes one record + its index entry. Caller holds p.mu.
func (p *VapidPushManager) deleteRecordLocked(pubkey, h string) {
	_ = p.kv.Set(p.recordKey(pubkey, h), "") // tombstone; kv has no delete
	hashes := p.loadIndex(pubkey)
	out := hashes[:0]
	for _, x := range hashes {
		if x != h {
			out = append(out, x)
		}
	}
	p.saveIndex(pubkey, out)
}

func (p *VapidPushManager) deleteAllRecords(pubkey string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, h := range p.loadIndex(pubkey) {
		_ = p.kv.Set(p.recordKey(pubkey, h), "")
	}
	p.saveIndex(pubkey, nil)
}

func (p *VapidPushManager) recordsForPubkey(pubkey string) []pushRecord {
	p.mu.RLock()
	defer p.mu.RUnlock()
	var out []pushRecord
	for _, h := range p.loadIndex(pubkey) {
		raw, err := p.kv.Get(p.recordKey(pubkey, h))
		if err != nil || raw == "" {
			continue
		}
		var rec pushRecord
		if json.Unmarshal([]byte(raw), &rec) != nil {
			continue
		}
		out = append(out, rec)
	}
	return out
}

func contains(ss []string, v string) bool {
	for _, s := range ss {
		if s == v {
			return true
		}
	}
	return false
}

// ── Fan-out ──────────────────────────────────────────────────────────────────

type notification struct {
	Title string           `json:"title"`
	Body  string           `json:"body"`
	Icon  string           `json:"icon,omitempty"`
	Badge string           `json:"badge,omitempty"`
	Data  notificationData `json:"data"`
}

type notificationData struct {
	URL string `json:"url"`
	Tag string `json:"tag"`
}

// FanOut resolves recipients for an event and sends each their push. Runs in its
// own goroutine; must never panic the relay.
func (p *VapidPushManager) FanOut(event nostr.Event) {
	defer func() {
		if rec := recover(); rec != nil {
			log.Printf("[push] fan-out panicked: %v", rec)
		}
	}()

	if p.vapid.PublicKey == "" {
		return
	}

	targets := p.resolveTargets(event)
	if len(targets) == 0 {
		return
	}

	sem := make(chan struct{}, pushSendBurst)
	var wg sync.WaitGroup
	for pubkey, note := range targets {
		for _, rec := range p.recordsForPubkey(pubkey) {
			if !wantsNotification(rec.Prefs, event, pubkey) {
				continue
			}
			wg.Add(1)
			sem <- struct{}{}
			go func(rec pushRecord, note notification) {
				defer wg.Done()
				defer func() { <-sem }()
				p.send(rec, note)
			}(rec, note)
		}
	}
	wg.Wait()
}

func (p *VapidPushManager) resolveTargets(event nostr.Event) map[string]notification {
	targets := map[string]notification{}
	author := event.PubKey.Hex()

	switch event.Kind {
	case 9: // group chat message
		groupId := tagValue(event, "h")
		if groupId == "" {
			return nil
		}
		title, icon := p.groupTitleIcon(groupId)
		body := truncate(event.Content, pushContentCap)
		clickURL := p.groupURL(groupId)
		mentioned := pSet(event)
		for _, member := range p.instance.Groups.GetMembers(groupId) {
			m := member.Hex()
			if m == author {
				continue
			}
			note := notification{
				Title: title,
				Body:  body,
				Icon:  icon,
				Data:  notificationData{URL: clickURL, Tag: "group:" + groupId},
			}
			if mentioned[m] {
				note.Title = title + " — mentioned you"
			}
			targets[m] = note
		}

	case 7: // reaction
		groupId := tagValue(event, "h")
		title, _ := p.groupTitleIcon(groupId)
		emoji := strings.TrimSpace(event.Content)
		if emoji == "" || emoji == "+" {
			emoji = "❤️"
		}
		for recipient := range pSet(event) {
			if recipient == author {
				continue
			}
			targets[recipient] = notification{
				Title: title,
				Body:  "Someone reacted " + emoji + " to your message",
				Data:  notificationData{URL: p.groupURL(groupId), Tag: "reaction:" + groupId},
			}
		}

	case 1111: // threaded reply (NIP-22 comment)
		groupId := tagValue(event, "h")
		title, _ := p.groupTitleIcon(groupId)
		body := truncate(event.Content, pushContentCap)
		for recipient := range pSet(event) {
			if recipient == author {
				continue
			}
			targets[recipient] = notification{
				Title: title + " — replied to you",
				Body:  body,
				Data:  notificationData{URL: p.groupURL(groupId), Tag: "reply:" + groupId},
			}
		}

	case 4: // NIP-04 DM (content encrypted; body generic)
		for recipient := range pSet(event) {
			if recipient == author {
				continue
			}
			targets[recipient] = notification{
				Title: "New message",
				Body:  "You received a direct message",
				Data:  notificationData{URL: "/dms/" + author, Tag: "dm:" + author},
			}
		}
	}

	return targets
}

func wantsNotification(prefs pushPrefs, event nostr.Event, recipient string) bool {
	mentioned := pSet(event)[recipient]
	switch event.Kind {
	case 9:
		if mentioned {
			return prefEnabled(prefs.Mentions, true)
		}
		return prefEnabled(prefs.AllGroupMessages, false)
	case 7:
		return prefEnabled(prefs.Reactions, true)
	case 1111:
		return prefEnabled(prefs.Replies, true)
	case 4:
		return prefEnabled(prefs.DirectMessages, true)
	}
	return false
}

func (p *VapidPushManager) send(rec pushRecord, note notification) {
	if note.Icon == "" {
		note.Icon = "/favicon.png"
	}
	if note.Badge == "" {
		note.Badge = "/favicon.png"
	}
	payload, err := json.Marshal(note)
	if err != nil {
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	resp, err := webpush.SendNotificationWithContext(ctx, payload, &rec.Subscription, &webpush.Options{
		Subscriber:      p.vapidSubject(),
		VAPIDPublicKey:  p.vapid.PublicKey,
		VAPIDPrivateKey: p.vapid.PrivateKey,
		TTL:             pushTTLSeconds,
		Urgency:         webpush.UrgencyHigh,
	})
	if err != nil {
		return
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))

	if resp.StatusCode == http.StatusGone || resp.StatusCode == http.StatusNotFound {
		p.deleteRecord(rec.Pubkey, rec.Subscription.Endpoint)
	}
}

// ── helpers ──────────────────────────────────────────────────────────────────

// groupTitleIcon returns the group's display name (falling back to its id) and
// picture from its NIP-29 metadata event.
func (p *VapidPushManager) groupTitleIcon(groupId string) (title, icon string) {
	title = groupId
	if groupId == "" {
		title = p.instance.Config.Info.Name
		return title, ""
	}
	meta, found := p.instance.Groups.GetMetadata(groupId)
	if !found {
		return title, ""
	}
	if t := meta.Tags.Find("name"); t != nil && t[1] != "" {
		title = t[1]
	}
	if t := meta.Tags.Find("picture"); t != nil {
		icon = t[1]
	}
	return title, icon
}

// groupURL builds the SPA route the client uses for a group on this host:
// /s/<route-param>/<groupId>, where route-param mirrors the client's
// relayToRouteParam(wss://<host>).
func (p *VapidPushManager) groupURL(groupId string) string {
	if groupId == "" {
		return "/"
	}
	return "/s/" + url.QueryEscape(p.instance.Config.Host) + "/" + url.PathEscape(groupId)
}

func tagValue(event nostr.Event, name string) string {
	if t := event.Tags.Find(name); t != nil {
		return t[1]
	}
	return ""
}

func pSet(event nostr.Event) map[string]bool {
	out := map[string]bool{}
	for tag := range event.Tags.FindAll("p") {
		if len(tag) >= 2 && isHex64(tag[1]) {
			out[tag[1]] = true
		}
	}
	return out
}

func truncate(s string, n int) string {
	s = strings.TrimSpace(s)
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return strings.TrimSpace(string(r[:n])) + "…"
}

func isSafePushEndpoint(endpoint string) bool {
	if !strings.HasPrefix(strings.ToLower(endpoint), "https://") {
		return false
	}
	lower := strings.ToLower(endpoint)
	for _, bad := range []string{
		"localhost", "127.0.0.1", "0.0.0.0", "::1",
		"169.254.169.254", "metadata.google.internal",
		"//10.", "//192.168.", "//172.16.", "//172.17.", "//172.18.",
		"//172.19.", "//172.2", "//172.30.", "//172.31.",
	} {
		if strings.Contains(lower, bad) {
			return false
		}
	}
	return true
}
