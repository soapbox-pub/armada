package zooid

import (
	"crypto/rand"
	"encoding/hex"
	"net"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"fiatjaf.com/nostr"
)

// Shared utilities for the Armada voice extensions (LiveKit DM rooms and the
// Concord blind broker) ported onto zooid. These mirror the originals from
// Armada's relay29-based server: crypto-random identity suffixes, an anti-replay
// cache for one-shot NIP-98/Concord grants, and a per-IP token-bucket limiter
// for the CPU-bound (signature-verifying) token endpoints.

var hex64Re = regexp.MustCompile(`^[0-9a-f]{64}$`)

func isHex64(s string) bool {
	return hex64Re.MatchString(s)
}

// randHex returns 2n lowercase hex chars of cryptographically secure randomness.
func randHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// ── CORS ─────────────────────────────────────────────────────────────────────

// voiceCORS sets permissive CORS headers for the voice/push endpoints. The web
// client is served from the same origin in the single-domain deployment, but
// because auth lives in the Authorization header (NIP-98/Concord grant) rather
// than cookies, a wildcard origin is not directly exploitable, and a single
// zooid instance may legitimately serve clients from sibling community hosts.
func voiceCORS(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Vary", "Origin")
	w.Header().Set("Access-Control-Allow-Methods", "GET, PUT, DELETE, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Concord-Identity")
}

// ── Anti-replay grant cache ──────────────────────────────────────────────────

// replayWindow is how long a remembered grant id is retained. It must be at
// least the grant freshness window (±60s) so an id can't be evicted while the
// same grant would still pass the freshness check and be replayable.
const replayWindow = 2 * time.Minute

var (
	seenMu    sync.Mutex
	seenGrant = map[string]nostr.Timestamp{} // event id hex -> expiry
	seenOnce  sync.Once
)

func startGrantSweeper() {
	seenOnce.Do(func() {
		go func() {
			ticker := time.NewTicker(replayWindow)
			defer ticker.Stop()
			for range ticker.C {
				pruneSeenGrants()
			}
		}()
	})
}

// rememberGrant records the grant id as used and reports whether it was already
// seen (i.e. this is a replay). The first caller for a given id gets false; any
// subsequent caller within the retention window gets true.
func rememberGrant(id string) (replayed bool) {
	now := nostr.Now()
	expiry := now + nostr.Timestamp(replayWindow/time.Second)

	seenMu.Lock()
	defer seenMu.Unlock()
	if exp, ok := seenGrant[id]; ok && exp > now {
		return true
	}
	seenGrant[id] = expiry
	return false
}

func pruneSeenGrants() {
	now := nostr.Now()
	seenMu.Lock()
	defer seenMu.Unlock()
	for id, exp := range seenGrant {
		if exp <= now {
			delete(seenGrant, id)
		}
	}
}

// ── Per-IP rate limiter ──────────────────────────────────────────────────────

type rateLimiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket
	rate    float64 // tokens added per second
	burst   float64 // max tokens
}

type bucket struct {
	tokens float64
	last   time.Time
}

func newRateLimiter(ratePerSec, burst float64) *rateLimiter {
	rl := &rateLimiter{
		buckets: map[string]*bucket{},
		rate:    ratePerSec,
		burst:   burst,
	}
	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			rl.prune()
		}
	}()
	return rl
}

func (rl *rateLimiter) allow(key string) bool {
	now := time.Now()
	rl.mu.Lock()
	defer rl.mu.Unlock()
	b, ok := rl.buckets[key]
	if !ok {
		rl.buckets[key] = &bucket{tokens: rl.burst - 1, last: now}
		return true
	}
	elapsed := now.Sub(b.last).Seconds()
	b.last = now
	b.tokens += elapsed * rl.rate
	if b.tokens > rl.burst {
		b.tokens = rl.burst
	}
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

func (rl *rateLimiter) prune() {
	now := time.Now()
	rl.mu.Lock()
	defer rl.mu.Unlock()
	for key, b := range rl.buckets {
		if now.Sub(b.last).Seconds()*rl.rate >= rl.burst {
			delete(rl.buckets, key)
		}
	}
}

// limit wraps h, rejecting requests from an IP that exceeds the bucket with 429.
// OPTIONS preflights are never rate-limited (they carry no auth and must always
// answer for CORS to work).
func (rl *rateLimiter) limit(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			h(w, r)
			return
		}
		if !rl.allow(clientIP(r)) {
			voiceCORS(w)
			http.Error(w, "rate limited", http.StatusTooManyRequests)
			return
		}
		h(w, r)
	}
}

// clientIP extracts the caller's IP, honoring a single reverse-proxy hop. We
// trust X-Real-IP / the last X-Forwarded-For entry only because this service is
// designed to sit behind a known edge proxy; direct exposure would let a client
// spoof these. Falls back to the socket address.
func clientIP(r *http.Request) string {
	if xri := strings.TrimSpace(r.Header.Get("X-Real-IP")); xri != "" {
		return xri
	}
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		if ip := strings.TrimSpace(parts[len(parts)-1]); ip != "" {
			return ip
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// shared limiters for token + push endpoints across all instances. A single
// limiter keyed by IP is fine multi-tenant: the cost being throttled (signature
// verification) is per-process, not per-tenant.
var (
	tokenLimiter = newRateLimiter(1, 10)
	pushLimiter  = newRateLimiter(1, 10)
)
