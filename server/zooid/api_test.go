package zooid

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"fiatjaf.com/nostr"
)

func TestAPIHandler_Authentication(t *testing.T) {
	useTestConfigDir(t)

	// Create a test keypair for authentication
	secretKey := nostr.Generate()
	pubkey := secretKey.Public()

	// Create API handler with whitelist containing our test pubkey
	api := newTestAPIHandler(t, pubkey.Hex())

	t.Run("missing authorization header", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/relay/test", strings.NewReader("{}"))
		req.Host = "api.example.com"
		w := httptest.NewRecorder()

		api.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected status %d, got %d", http.StatusUnauthorized, w.Code)
		}
	})

	t.Run("invalid authorization format", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/relay/test", strings.NewReader("{}"))
		req.Host = "api.example.com"
		req.Header.Set("Authorization", "Bearer token123")
		w := httptest.NewRecorder()

		api.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected status %d, got %d", http.StatusUnauthorized, w.Code)
		}
	})

	t.Run("invalid base64", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/relay/test", strings.NewReader("{}"))
		req.Host = "api.example.com"
		req.Header.Set("Authorization", "Nostr not-valid-base64!!!")
		w := httptest.NewRecorder()

		api.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected status %d, got %d", http.StatusUnauthorized, w.Code)
		}
	})

	t.Run("invalid event kind", func(t *testing.T) {
		event := nostr.Event{
			Kind:      1, // Wrong kind
			CreatedAt: nostr.Now(),
			Tags: nostr.Tags{
				{"u", "http://api.example.com/relay/test"},
				{"method", "POST"},
			},
		}
		event.Sign(secretKey)

		req := createAuthRequest(http.MethodPost, "http://api.example.com/relay/test", event, "{}")
		w := httptest.NewRecorder()

		api.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected status %d, got %d", http.StatusUnauthorized, w.Code)
		}
	})

	t.Run("invalid signature", func(t *testing.T) {
		event := nostr.Event{
			Kind:      nostr.KindHTTPAuth,
			CreatedAt: nostr.Now(),
			Tags: nostr.Tags{
				{"u", "http://api.example.com/relay/test"},
				{"method", "POST"},
			},
		}
		// Don't sign the event - invalid signature

		req := createAuthRequest(http.MethodPost, "http://api.example.com/relay/test", event, "{}")
		w := httptest.NewRecorder()

		api.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected status %d, got %d", http.StatusUnauthorized, w.Code)
		}
	})

	t.Run("missing u tag", func(t *testing.T) {
		event := nostr.Event{
			Kind:      nostr.KindHTTPAuth,
			CreatedAt: nostr.Now(),
			Tags: nostr.Tags{
				{"method", "POST"},
			},
		}
		event.Sign(secretKey)

		req := createAuthRequest(http.MethodPost, "http://api.example.com/relay/test", event, "{}")
		w := httptest.NewRecorder()

		api.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected status %d, got %d", http.StatusUnauthorized, w.Code)
		}
	})

	t.Run("missing method tag", func(t *testing.T) {
		event := nostr.Event{
			Kind:      nostr.KindHTTPAuth,
			CreatedAt: nostr.Now(),
			Tags: nostr.Tags{
				{"u", "http://api.example.com/relay/test"},
			},
		}
		event.Sign(secretKey)

		req := createAuthRequest(http.MethodPost, "http://api.example.com/relay/test", event, "{}")
		w := httptest.NewRecorder()

		api.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected status %d, got %d", http.StatusUnauthorized, w.Code)
		}
	})

	t.Run("pubkey not in whitelist", func(t *testing.T) {
		// Create a different keypair not in whitelist
		otherSecret := nostr.Generate()

		event := nostr.Event{
			Kind:      nostr.KindHTTPAuth,
			CreatedAt: nostr.Now(),
			Tags: nostr.Tags{
				{"u", "http://api.example.com/relay/test"},
				{"method", "POST"},
			},
		}
		event.Sign(otherSecret)

		req := createAuthRequest(http.MethodPost, "http://api.example.com/relay/test", event, "{}")
		w := httptest.NewRecorder()

		api.ServeHTTP(w, req)

		if w.Code != http.StatusForbidden {
			t.Errorf("expected status %d, got %d", http.StatusForbidden, w.Code)
		}
	})
}

func TestAPIHandler_CreateRelay(t *testing.T) {
	configDir := useTestConfigDir(t)

	secretKey := nostr.Generate()
	pubkey := secretKey.Public()
	api := newTestAPIHandler(t, pubkey.Hex())

	validConfig := map[string]interface{}{
		"host":   "relay.example.com",
		"schema": "testrelay",
		"secret": secretKey.Hex(),
		"info": map[string]interface{}{
			"name":        "Test Relay",
			"pubkey":      pubkey.Hex(),
			"description": "A test relay",
		},
	}

	t.Run("create relay successfully", func(t *testing.T) {
		body, _ := json.Marshal(validConfig)
		req := createAuthenticatedRequest(http.MethodPost, "http://api.example.com/relay/newrelay", secretKey, body)
		w := httptest.NewRecorder()

		api.ServeHTTP(w, req)

		if w.Code != http.StatusCreated {
			t.Errorf("expected status %d, got %d: %s", http.StatusCreated, w.Code, w.Body.String())
		}

		// Verify file was created
		configPath := filepath.Join(configDir, "newrelay.toml")
		if _, err := os.Stat(configPath); os.IsNotExist(err) {
			t.Error("config file was not created")
		}
	})

	t.Run("duplicate id returns conflict", func(t *testing.T) {
		body, _ := json.Marshal(validConfig)
		req := createAuthenticatedRequest(http.MethodPost, "http://api.example.com/relay/newrelay", secretKey, body)
		w := httptest.NewRecorder()

		api.ServeHTTP(w, req)

		if w.Code != http.StatusConflict {
			t.Errorf("expected status %d, got %d", http.StatusConflict, w.Code)
		}
	})

	t.Run("duplicate schema returns conflict", func(t *testing.T) {
		config := map[string]interface{}{
			"host":   "other.example.com",
			"schema": "testrelay", // Same schema as existing
			"secret": secretKey.Hex(),
			"info": map[string]interface{}{
				"pubkey": pubkey.Hex(),
			},
		}
		body, _ := json.Marshal(config)
		req := createAuthenticatedRequest(http.MethodPost, "http://api.example.com/relay/other", secretKey, body)
		w := httptest.NewRecorder()

		api.ServeHTTP(w, req)

		if w.Code != http.StatusConflict {
			t.Errorf("expected status %d, got %d", http.StatusConflict, w.Code)
		}
	})

	t.Run("duplicate host returns conflict", func(t *testing.T) {
		config := map[string]interface{}{
			"host":   "relay.example.com", // Same host as existing
			"schema": "otherschema",
			"secret": secretKey.Hex(),
			"info": map[string]interface{}{
				"pubkey": pubkey.Hex(),
			},
		}
		body, _ := json.Marshal(config)
		req := createAuthenticatedRequest(http.MethodPost, "http://api.example.com/relay/other2", secretKey, body)
		w := httptest.NewRecorder()

		api.ServeHTTP(w, req)

		if w.Code != http.StatusConflict {
			t.Errorf("expected status %d, got %d", http.StatusConflict, w.Code)
		}
	})

	t.Run("missing required fields", func(t *testing.T) {
		config := map[string]interface{}{
			"host": "relay.example.com",
			// missing schema and secret
		}
		body, _ := json.Marshal(config)
		req := createAuthenticatedRequest(http.MethodPost, "http://api.example.com/relay/badrelay", secretKey, body)
		w := httptest.NewRecorder()

		api.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected status %d, got %d", http.StatusBadRequest, w.Code)
		}
	})

	t.Run("invalid secret key", func(t *testing.T) {
		config := map[string]interface{}{
			"host":   "relay.example.com",
			"schema": "badrelay",
			"secret": "not-a-valid-hex-key",
		}
		body, _ := json.Marshal(config)
		req := createAuthenticatedRequest(http.MethodPost, "http://api.example.com/relay/badrelay", secretKey, body)
		w := httptest.NewRecorder()

		api.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected status %d, got %d", http.StatusBadRequest, w.Code)
		}
	})

	t.Run("invalid json", func(t *testing.T) {
		req := createAuthenticatedRequest(http.MethodPost, "http://api.example.com/relay/badrelay", secretKey, []byte("not json"))
		w := httptest.NewRecorder()

		api.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected status %d, got %d", http.StatusBadRequest, w.Code)
		}
	})
}

func TestAPIHandler_UpdateRelay(t *testing.T) {
	useTestConfigDir(t)

	secretKey := nostr.Generate()
	pubkey := secretKey.Public()
	api := newTestAPIHandler(t, pubkey.Hex())

	// Create initial relay
	initialConfig := map[string]interface{}{
		"host":   "relay.example.com",
		"schema": "testrelay",
		"secret": secretKey.Hex(),
		"info": map[string]interface{}{
			"name":   "Test Relay",
			"pubkey": pubkey.Hex(),
		},
	}
	body, _ := json.Marshal(initialConfig)
	req := createAuthenticatedRequest(http.MethodPost, "http://api.example.com/relay/testrelay", secretKey, body)
	w := httptest.NewRecorder()
	api.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("failed to create initial relay: %d - %s", w.Code, w.Body.String())
	}

	t.Run("update existing relay", func(t *testing.T) {
		updatedConfig := map[string]interface{}{
			"host":   "relay.example.com",
			"schema": "testrelay",
			"secret": secretKey.Hex(),
			"info": map[string]interface{}{
				"name":        "Updated Relay Name",
				"pubkey":      pubkey.Hex(),
				"description": "Updated description",
			},
		}
		body, _ := json.Marshal(updatedConfig)
		req := createAuthenticatedRequest(http.MethodPut, "http://api.example.com/relay/testrelay", secretKey, body)
		w := httptest.NewRecorder()

		api.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected status %d, got %d: %s", http.StatusOK, w.Code, w.Body.String())
		}
	})

	t.Run("update non-existent relay returns not found", func(t *testing.T) {
		config := map[string]interface{}{
			"host":   "nonexistent.example.com",
			"schema": "nonexistent",
			"secret": secretKey.Hex(),
		}
		body, _ := json.Marshal(config)
		req := createAuthenticatedRequest(http.MethodPut, "http://api.example.com/relay/nonexistent", secretKey, body)
		w := httptest.NewRecorder()

		api.ServeHTTP(w, req)

		if w.Code != http.StatusNotFound {
			t.Errorf("expected status %d, got %d", http.StatusNotFound, w.Code)
		}
	})

	t.Run("update with duplicate schema", func(t *testing.T) {
		// Create another relay first
		otherConfig := map[string]interface{}{
			"host":   "other.example.com",
			"schema": "otherrelay",
			"secret": secretKey.Hex(),
			"info": map[string]interface{}{
				"pubkey": pubkey.Hex(),
			},
		}
		body, _ := json.Marshal(otherConfig)
		req := createAuthenticatedRequest(http.MethodPost, "http://api.example.com/relay/otherrelay", secretKey, body)
		w := httptest.NewRecorder()
		api.ServeHTTP(w, req)
		if w.Code != http.StatusCreated {
			t.Fatalf("failed to create other relay: %d", w.Code)
		}

		// Try to update first relay with second relay's schema
		updateConfig := map[string]interface{}{
			"host":   "relay.example.com",
			"schema": "otherrelay", // Duplicate
			"secret": secretKey.Hex(),
			"info": map[string]interface{}{
				"pubkey": pubkey.Hex(),
			},
		}
		body, _ = json.Marshal(updateConfig)
		req = createAuthenticatedRequest(http.MethodPut, "http://api.example.com/relay/testrelay", secretKey, body)
		w = httptest.NewRecorder()

		api.ServeHTTP(w, req)

		if w.Code != http.StatusConflict {
			t.Errorf("expected status %d, got %d", http.StatusConflict, w.Code)
		}
	})
}

func TestAPIHandler_PatchRelay(t *testing.T) {
	useTestConfigDir(t)

	secretKey := nostr.Generate()
	pubkey := secretKey.Public()
	api := newTestAPIHandler(t, pubkey.Hex())

	// Create initial relay with full config
	initialConfig := map[string]interface{}{
		"host":   "relay.example.com",
		"schema": "testrelay",
		"secret": secretKey.Hex(),
		"info": map[string]interface{}{
			"name":        "Original Name",
			"icon":        "https://example.com/original.png",
			"pubkey":      pubkey.Hex(),
			"description": "Original description",
		},
		"policy": map[string]interface{}{
			"public_join":      false,
			"strip_signatures": false,
		},
		"groups": map[string]interface{}{
			"enabled": true,
		},
	}
	body, _ := json.Marshal(initialConfig)
	req := createAuthenticatedRequest(http.MethodPost, "http://api.example.com/relay/testrelay", secretKey, body)
	w := httptest.NewRecorder()
	api.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("failed to create initial relay: %d - %s", w.Code, w.Body.String())
	}

	t.Run("patch existing relay - update single field", func(t *testing.T) {
		patch := map[string]interface{}{
			"info": map[string]interface{}{
				"name": "Patched Name",
			},
		}
		body, _ := json.Marshal(patch)
		req := createAuthenticatedRequest(http.MethodPatch, "http://api.example.com/relay/testrelay", secretKey, body)
		w := httptest.NewRecorder()

		api.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected status %d, got %d: %s", http.StatusOK, w.Code, w.Body.String())
		}
	})

	t.Run("patch existing relay - update nested fields", func(t *testing.T) {
		patch := map[string]interface{}{
			"info": map[string]interface{}{
				"description": "Updated description",
				"icon":        "https://example.com/new-icon.png",
			},
			"policy": map[string]interface{}{
				"public_join": true,
			},
		}
		body, _ := json.Marshal(patch)
		req := createAuthenticatedRequest(http.MethodPatch, "http://api.example.com/relay/testrelay", secretKey, body)
		w := httptest.NewRecorder()

		api.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected status %d, got %d: %s", http.StatusOK, w.Code, w.Body.String())
		}
	})

	t.Run("patch non-existent relay returns not found", func(t *testing.T) {
		patch := map[string]interface{}{
			"info": map[string]interface{}{
				"name": "New Name",
			},
		}
		body, _ := json.Marshal(patch)
		req := createAuthenticatedRequest(http.MethodPatch, "http://api.example.com/relay/nonexistent", secretKey, body)
		w := httptest.NewRecorder()

		api.ServeHTTP(w, req)

		if w.Code != http.StatusNotFound {
			t.Errorf("expected status %d, got %d", http.StatusNotFound, w.Code)
		}
	})

	t.Run("patch with duplicate schema returns conflict", func(t *testing.T) {
		// Create another relay first
		otherConfig := map[string]interface{}{
			"host":   "other.example.com",
			"schema": "anotherrelay",
			"secret": secretKey.Hex(),
			"info": map[string]interface{}{
				"pubkey": pubkey.Hex(),
			},
		}
		body, _ := json.Marshal(otherConfig)
		req := createAuthenticatedRequest(http.MethodPost, "http://api.example.com/relay/anotherrelay", secretKey, body)
		w := httptest.NewRecorder()
		api.ServeHTTP(w, req)
		if w.Code != http.StatusCreated {
			t.Fatalf("failed to create other relay: %d", w.Code)
		}

		// Try to patch first relay with second relay's schema
		patch := map[string]interface{}{
			"schema": "anotherrelay", // Duplicate
		}
		body, _ = json.Marshal(patch)
		req = createAuthenticatedRequest(http.MethodPatch, "http://api.example.com/relay/testrelay", secretKey, body)
		w = httptest.NewRecorder()

		api.ServeHTTP(w, req)

		if w.Code != http.StatusConflict {
			t.Errorf("expected status %d, got %d", http.StatusConflict, w.Code)
		}
	})

	t.Run("patch with invalid secret key", func(t *testing.T) {
		patch := map[string]interface{}{
			"secret": "not-a-valid-hex-key",
		}
		body, _ := json.Marshal(patch)
		req := createAuthenticatedRequest(http.MethodPatch, "http://api.example.com/relay/testrelay", secretKey, body)
		w := httptest.NewRecorder()

		api.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected status %d, got %d", http.StatusBadRequest, w.Code)
		}
	})

	t.Run("patch removing required field fails", func(t *testing.T) {
		patch := map[string]interface{}{
			"host": nil,
		}
		body, _ := json.Marshal(patch)
		req := createAuthenticatedRequest(http.MethodPatch, "http://api.example.com/relay/testrelay", secretKey, body)
		w := httptest.NewRecorder()

		api.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected status %d, got %d", http.StatusBadRequest, w.Code)
		}
	})
}

func TestAPIHandler_DeleteRelay(t *testing.T) {
	configDir := useTestConfigDir(t)

	secretKey := nostr.Generate()
	pubkey := secretKey.Public()
	api := newTestAPIHandler(t, pubkey.Hex())

	// Create a relay to delete
	config := map[string]interface{}{
		"host":   "relay.example.com",
		"schema": "deleterelay",
		"secret": secretKey.Hex(),
		"info": map[string]interface{}{
			"name":   "Delete Me",
			"pubkey": pubkey.Hex(),
		},
	}
	body, _ := json.Marshal(config)
	req := createAuthenticatedRequest(http.MethodPost, "http://api.example.com/relay/deleterelay", secretKey, body)
	w := httptest.NewRecorder()
	api.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("failed to create relay: %d", w.Code)
	}

	t.Run("delete existing relay", func(t *testing.T) {
		req := createAuthenticatedRequest(http.MethodDelete, "http://api.example.com/relay/deleterelay", secretKey, nil)
		w := httptest.NewRecorder()

		api.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected status %d, got %d", http.StatusOK, w.Code)
		}

		// Verify file was deleted
		configPath := filepath.Join(configDir, "deleterelay.toml")
		if _, err := os.Stat(configPath); !os.IsNotExist(err) {
			t.Error("config file was not deleted")
		}
	})

	t.Run("delete non-existent relay returns not found", func(t *testing.T) {
		req := createAuthenticatedRequest(http.MethodDelete, "http://api.example.com/relay/nonexistent", secretKey, nil)
		w := httptest.NewRecorder()

		api.ServeHTTP(w, req)

		if w.Code != http.StatusNotFound {
			t.Errorf("expected status %d, got %d", http.StatusNotFound, w.Code)
		}
	})
}

func TestAPIHandler_ListRelayMembers(t *testing.T) {
	useTestConfigDir(t)

	secretKey := nostr.Generate()
	pubkey := secretKey.Public()
	api := newTestAPIHandler(t, pubkey.Hex())

	t.Run("list members from loaded relay instance", func(t *testing.T) {
		member1 := nostr.Generate().Public()
		member2 := nostr.Generate().Public()

		management := createTestManagementStore()
		if err := management.AllowPubkey(member1); err != nil {
			t.Fatalf("failed to add first member: %v", err)
		}
		if err := management.AllowPubkey(member2); err != nil {
			t.Fatalf("failed to add second member: %v", err)
		}

		instancesMux.Lock()
		oldByName := instancesByName
		oldByHost := instancesByHost
		instancesByName = map[string]*Instance{
			"loaded.toml": {
				Config:     &Config{Inactive: false},
				Management: management,
			},
		}
		instancesByHost = map[string]*Instance{}
		instancesMux.Unlock()
		defer func() {
			instancesMux.Lock()
			instancesByName = oldByName
			instancesByHost = oldByHost
			instancesMux.Unlock()
		}()

		req := createAuthenticatedRequest(http.MethodGet, "http://api.example.com/relay/loaded/members", secretKey, nil)
		w := httptest.NewRecorder()

		api.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected status %d, got %d: %s", http.StatusOK, w.Code, w.Body.String())
		}

		var payload struct {
			Members []string `json:"members"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
			t.Fatalf("failed to unmarshal response: %v", err)
		}

		expected := map[string]struct{}{
			member1.Hex(): {},
			member2.Hex(): {},
		}

		if len(payload.Members) != len(expected) {
			t.Fatalf("expected %d members, got %d (%v)", len(expected), len(payload.Members), payload.Members)
		}

		for _, actual := range payload.Members {
			if _, ok := expected[actual]; !ok {
				t.Fatalf("unexpected member in response: %s", actual)
			}
		}
	})

	t.Run("list members from config fallback", func(t *testing.T) {
		relaySecret := nostr.Generate()
		member1 := nostr.Generate().Public()
		member2 := nostr.Generate().Public()

		config := &Config{
			Host:   "members.example.com",
			Schema: "members_" + strings.ToLower(RandomString(8)),
			Secret: relaySecret.Hex(),
		}
		config.Info.Pubkey = nostr.Generate().Public().Hex()
		config.path = ConfigPathFromName(ConfigNameFromId("fallback"))

		if err := config.Save(); err != nil {
			t.Fatalf("failed to save config: %v", err)
		}

		// Seed DB with RELAY_MEMBERS to simulate a prior relay load.
		seedEvents := &EventStore{
			Config: &Config{secret: relaySecret},
			Schema: &Schema{Name: config.Schema},
		}
		if err := seedEvents.Init(); err != nil {
			t.Fatalf("failed to init seed events: %v", err)
		}
		membersEvent := nostr.Event{
			Kind:      RELAY_MEMBERS,
			CreatedAt: nostr.Now(),
			Tags: nostr.Tags{
				{"-"},
				{"member", member1.Hex()},
				{"member", member2.Hex()},
			},
		}
		if err := seedEvents.SignAndStoreEvent(&membersEvent, false); err != nil {
			t.Fatalf("failed to seed members event: %v", err)
		}

		instancesMux.Lock()
		oldByName := instancesByName
		oldByHost := instancesByHost
		instancesByName = map[string]*Instance{}
		instancesByHost = map[string]*Instance{}
		instancesMux.Unlock()
		defer func() {
			instancesMux.Lock()
			instancesByName = oldByName
			instancesByHost = oldByHost
			instancesMux.Unlock()
		}()

		req := createAuthenticatedRequest(http.MethodGet, "http://api.example.com/relay/fallback/members", secretKey, nil)
		w := httptest.NewRecorder()

		api.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected status %d, got %d: %s", http.StatusOK, w.Code, w.Body.String())
		}

		var payload struct {
			Members []string `json:"members"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
			t.Fatalf("failed to unmarshal response: %v", err)
		}

		expected := map[string]struct{}{
			member1.Hex(): {},
			member2.Hex(): {},
		}

		if len(payload.Members) != len(expected) {
			t.Fatalf("expected %d members, got %d (%v)", len(expected), len(payload.Members), payload.Members)
		}

		for _, actual := range payload.Members {
			if _, ok := expected[actual]; !ok {
				t.Fatalf("unexpected member in response: %s", actual)
			}
		}
	})

	t.Run("non-existent relay returns not found", func(t *testing.T) {
		req := createAuthenticatedRequest(http.MethodGet, "http://api.example.com/relay/missing/members", secretKey, nil)
		w := httptest.NewRecorder()

		api.ServeHTTP(w, req)

		if w.Code != http.StatusNotFound {
			t.Fatalf("expected status %d, got %d", http.StatusNotFound, w.Code)
		}
	})

	t.Run("members endpoint rejects non-get methods", func(t *testing.T) {
		req := createAuthenticatedRequest(http.MethodPost, "http://api.example.com/relay/loaded/members", secretKey, []byte("{}"))
		w := httptest.NewRecorder()

		api.ServeHTTP(w, req)

		if w.Code != http.StatusMethodNotAllowed {
			t.Fatalf("expected status %d, got %d", http.StatusMethodNotAllowed, w.Code)
		}
	})
}

func TestAPIHandler_MethodNotAllowed(t *testing.T) {
	useTestConfigDir(t)

	secretKey := nostr.Generate()
	pubkey := secretKey.Public()
	api := newTestAPIHandler(t, pubkey.Hex())

	t.Run("GET method not allowed", func(t *testing.T) {
		req := createAuthenticatedRequest(http.MethodGet, "http://api.example.com/relay/test", secretKey, nil)
		w := httptest.NewRecorder()

		api.ServeHTTP(w, req)

		if w.Code != http.StatusMethodNotAllowed {
			t.Errorf("expected status %d, got %d", http.StatusMethodNotAllowed, w.Code)
		}
	})
}

func TestAPIHandler_InvalidPath(t *testing.T) {
	useTestConfigDir(t)

	secretKey := nostr.Generate()
	pubkey := secretKey.Public()
	api := newTestAPIHandler(t, pubkey.Hex())

	t.Run("invalid path returns not found", func(t *testing.T) {
		req := createAuthenticatedRequest(http.MethodPost, "http://api.example.com/invalid/path", secretKey, []byte("{}"))
		w := httptest.NewRecorder()

		api.ServeHTTP(w, req)

		if w.Code != http.StatusNotFound {
			t.Errorf("expected status %d, got %d", http.StatusNotFound, w.Code)
		}
	})

	t.Run("missing relay id", func(t *testing.T) {
		req := createAuthenticatedRequest(http.MethodPost, "http://api.example.com/relay/", secretKey, []byte("{}"))
		w := httptest.NewRecorder()

		api.ServeHTTP(w, req)

		if w.Code != http.StatusNotFound {
			t.Errorf("expected status %d, got %d", http.StatusNotFound, w.Code)
		}
	})
}

func TestAPIHandler_ConfigValidation(t *testing.T) {
	configDir := useTestConfigDir(t)

	secretKey := nostr.Generate()
	pubkey := secretKey.Public()
	api := newTestAPIHandler(t, pubkey.Hex())

	t.Run("invalid info.pubkey", func(t *testing.T) {
		config := map[string]interface{}{
			"host":   "relay.example.com",
			"schema": "badpubkey",
			"secret": secretKey.Hex(),
			"info": map[string]interface{}{
				"name":   "Test",
				"pubkey": "not-a-valid-pubkey",
			},
		}
		body, _ := json.Marshal(config)
		req := createAuthenticatedRequest(http.MethodPost, "http://api.example.com/relay/badpubkey", secretKey, body)
		w := httptest.NewRecorder()

		api.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected status %d, got %d", http.StatusBadRequest, w.Code)
		}
	})

	t.Run("valid full config", func(t *testing.T) {
		config := map[string]interface{}{
			"host":   "full.example.com",
			"schema": "fullrelay",
			"secret": secretKey.Hex(),
			"info": map[string]interface{}{
				"name":        "Full Test Relay",
				"icon":        "https://example.com/icon.png",
				"pubkey":      pubkey.Hex(),
				"description": "A full test relay",
			},
			"policy": map[string]interface{}{
				"public_join":      true,
				"strip_signatures": false,
			},
			"groups": map[string]interface{}{
				"enabled": true,
			},
			"push": map[string]interface{}{
				"enabled": true,
			},
			"management": map[string]interface{}{
				"enabled": true,
			},
			"blossom": map[string]interface{}{
				"enabled": true,
			},
			"roles": map[string]interface{}{
				"member": map[string]interface{}{
					"can_invite": true,
					"can_manage": false,
				},
			},
		}
		body, _ := json.Marshal(config)
		req := createAuthenticatedRequest(http.MethodPost, "http://api.example.com/relay/fullrelay", secretKey, body)
		w := httptest.NewRecorder()

		api.ServeHTTP(w, req)

		if w.Code != http.StatusCreated {
			t.Errorf("expected status %d, got %d: %s", http.StatusCreated, w.Code, w.Body.String())
		}

		// Verify the TOML file was created with correct content
		configPath := filepath.Join(configDir, "fullrelay.toml")
		content, err := os.ReadFile(configPath)
		if err != nil {
			t.Fatalf("failed to read config file: %v", err)
		}

		contentStr := string(content)
		if !strings.Contains(contentStr, "host = \"full.example.com\"") {
			t.Error("TOML missing host")
		}
		if !strings.Contains(contentStr, "schema = \"fullrelay\"") {
			t.Error("TOML missing schema")
		}
		if !strings.Contains(contentStr, "name = \"Full Test Relay\"") {
			t.Error("TOML missing info.name")
		}
		if !strings.Contains(contentStr, "enabled = true") {
			t.Error("TOML missing enabled flags")
		}
	})
}

// Helper functions

func createAuthRequest(method, url string, event nostr.Event, body string) *http.Request {
	var bodyReader *bytes.Reader
	if body != "" {
		bodyReader = bytes.NewReader([]byte(body))
	} else {
		bodyReader = bytes.NewReader([]byte{})
	}

	req := httptest.NewRequest(method, url, bodyReader)
	req.Host = "api.example.com"

	jevt, _ := json.Marshal(event)
	authHeader := "Nostr " + base64.StdEncoding.EncodeToString(jevt)
	req.Header.Set("Authorization", authHeader)
	req.Header.Set("Content-Type", "application/json")

	return req
}

func createAuthenticatedRequest(method, url string, secretKey nostr.SecretKey, body []byte) *http.Request {
	var bodyReader *bytes.Reader
	if body != nil {
		bodyReader = bytes.NewReader(body)
	} else {
		bodyReader = bytes.NewReader([]byte{})
	}

	req := httptest.NewRequest(method, url, bodyReader)
	req.Host = "api.example.com"

	// Create NIP-98 auth event
	event := nostr.Event{
		Kind:      nostr.KindHTTPAuth,
		CreatedAt: nostr.Now(),
		Tags: nostr.Tags{
			{"u", url},
			{"method", method},
		},
	}
	event.Sign(secretKey)

	jevt, _ := json.Marshal(event)
	authHeader := "Nostr " + base64.StdEncoding.EncodeToString(jevt)
	req.Header.Set("Authorization", authHeader)
	req.Header.Set("Content-Type", "application/json")

	return req
}

// setTestEnv overrides a value in the package-level env map. Env memoizes
// os.Environ via sync.Once, so once the test binary has started, os.Setenv is
// ignored — mutating the cached map directly is the only way to change config
// for an individual test. Safe because tests in this package run sequentially.
func setTestEnv(key, value string) {
	_ = Env("DATA") // ensure the env map has been initialized
	env[key] = value
}

// useTestConfigDir points Env("CONFIG") at a fresh temp dir for this test.
func useTestConfigDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	setTestEnv("CONFIG", dir)
	return dir
}

// newTestAPIHandler builds a handler whose whitelist contains the given pubkeys.
func newTestAPIHandler(t *testing.T, whitelist ...string) *APIHandler {
	t.Helper()
	setTestEnv("API_WHITELIST", strings.Join(whitelist, ","))
	return NewAPIHandler()
}

func TestNewAPIHandler(t *testing.T) {
	t.Run("empty whitelist", func(t *testing.T) {
		api := newTestAPIHandler(t)
		if len(api.whitelist) != 0 {
			t.Error("expected empty whitelist")
		}
	})

	t.Run("single pubkey", func(t *testing.T) {
		pubkey := nostr.Generate().Public().Hex()
		api := newTestAPIHandler(t, pubkey)
		if len(api.whitelist) != 1 {
			t.Error("expected 1 entry in whitelist")
		}
		if !api.whitelist[pubkey] {
			t.Error("pubkey not in whitelist")
		}
	})

	t.Run("multiple pubkeys", func(t *testing.T) {
		pubkey1 := nostr.Generate().Public().Hex()
		pubkey2 := nostr.Generate().Public().Hex()
		setTestEnv("API_WHITELIST", fmt.Sprintf("%s, %s", pubkey1, pubkey2))
		api := NewAPIHandler()
		if len(api.whitelist) != 2 {
			t.Error("expected 2 entries in whitelist")
		}
		if !api.whitelist[pubkey1] || !api.whitelist[pubkey2] {
			t.Error("pubkeys not in whitelist")
		}
	})

	t.Run("whitespace trimming", func(t *testing.T) {
		pubkey := nostr.Generate().Public().Hex()
		setTestEnv("API_WHITELIST", "  "+pubkey+"  ")
		api := NewAPIHandler()
		if len(api.whitelist) != 1 {
			t.Error("expected 1 entry in whitelist after trimming")
		}
	})
}
