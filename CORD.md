# Concord Extensions

Conventions the **Armada** client implements on top of the
[Concord protocol](https://github.com/concord-protocol/concord) (CORD-01
through CORD-07) that are **not** part of the official Concord specification —
the CORD analog of a project's `NIP.md`. They build on the base protocol's
sealed planes and interoperate with any Concord client that chooses to adopt
them; a client unaware of an extension simply ignores its events.

Nothing here is a ratified CORD. If an extension proves broadly useful it may
be proposed upstream later; until then it is an Armada implementation detail
documented for interoperability.

---

## Private Zaps

Lightning zaps on messages in a Channel, with **no public Nostr artifact**. A
member pays a message's author over Lightning and posts the proof into the
Channel's own Chat Plane; every member verifies the payment locally, and nobody
else — not the relays, not a zap indexer, not the recipient's wallet provider —
learns that a community, a message, or a zapper exists. It works with today's
Lightning address providers exactly as they are: the payment they see is
indistinguishable from any ordinary, Nostr-free Lightning payment.

### 1. Why not NIP-57 receipts

[NIP-57](https://github.com/nostr-protocol/nips/blob/master/57.md) attests a zap
with a public kind `9735` receipt, signed and published *by the recipient's
LNURL provider*. That shape is wrong for a sealed plane three times over: the
receipt is a public event naming the recipient, the amount, the time, and the
zapped event id; the provider chooses where it lands and must be trusted to
publish it; and no provider can seal a receipt into a plane it cannot see.
Asking providers to behave differently would make private zaps work only against
cooperating wallets — quietly reintroducing a trusted server.

Armada moves the attestation to the only party who is already inside the room:
the **payer**. A Lightning payment carries its own cryptographic proof — the
**preimage**, revealed to the payer on settlement, whose SHA-256 is the
invoice's `payment_hash`. The payer posts invoice + preimage as a sealed Chat
Plane event, and every member checks the math themselves. No third party
publishes anything.

### 2. Flow

1. **Resolve.** The payer reads the recipient's Lightning address
   (`lud16`/`lud06`) from their public kind `0` metadata — the one public
   touchpoint, inherent to Lightning addresses themselves.
2. **Fetch an invoice** via plain
   [LUD-06](https://github.com/lnurl/luds/blob/luds/06.md)/[LUD-16](https://github.com/lnurl/luds/blob/luds/16.md)
   LNURL-pay. The client MUST NOT include a NIP-57 `nostr` parameter in the
   callback: its presence is what causes a provider to mint a public kind `9735`
   receipt. Without it, the provider sees an ordinary Lightning payment and
   produces no Nostr event anywhere. The client MUST NOT include the LNURL
   `comment` parameter either — the zap comment belongs to the sealed
   announcement alone (§5), not to the recipient's wallet provider.
3. **Pay** with a method that returns the preimage — NIP-47 `pay_invoice` and
   WebLN `sendPayment` both do. A payment path that never reveals the preimage
   to the client (scanning the invoice with an external wallet) cannot produce a
   verifiable zap.
4. **Announce.** The payer publishes a Zap event (§3) to the Channel's Chat
   Plane, sealed to their real identity like any message.

### 3. The Zap event

Armada carries the Zap as a kind `9735` rumor on the Chat Plane — the NIP-57
receipt shape reused *inside* the sealed plane, with one addition: the
`preimage` tag that replaces the provider's signature as the proof. Note the
role reversal from NIP-57: there the receipt's author is the *provider*; here
the rumor's author (the seal's signer) is the *payer*. Because it never leaves
the sealed plane, reusing kind `9735` does not collide with public NIP-57
receipts.

```jsonc
{
  "kind": 9735,
  "pubkey": "<payer>",
  "content": "great post ⚡",                      // optional comment, "" when none
  "tags": [
    ["channel", "<channel_id>"],                   // binding tags, required on every
    ["epoch", "0"],                                //   chat rumor (CORD-03 §3)
    ["ms", "417"],
    ["e", "<zapped message rumor id>"],
    ["p", "<recipient real pubkey>"],
    ["k", "9"],                                    // kind of the zapped rumor
    ["amount", "21000"],                           // millisats, decimal string
    ["bolt11", "<the paid invoice>"],
    ["preimage", "<64-char lowercase hex>"]
  ],
  "created_at": 1686840350
}
```

`amount` follows the NIP-57 convention (millisats). The invoice MUST carry an
explicit amount; amountless invoices are not zappable (there would be nothing
for verifiers to check the tag against).

### 4. Verification

A receiver MUST verify, and MUST NOT count a Zap toward a message's totals
unless all of it holds:

- **Payment**: `sha256(preimage) == payment_hash` decoded from `bolt11`.
- **Amount**: the `amount` tag equals the invoice's encoded amount, in millisats.
- **Binding**: `channel` and `epoch` strict-equal the Channel and epoch whose
  key decrypted the wrap (CORD-03 §3), like every chat rumor.
- **Uniqueness**: the invoice's `payment_hash` has not already been counted in
  this Channel. A published Zap reveals its preimage to every member, so
  without this rule anyone could replay someone else's proof — as their own
  zap, or on another message — and one payment would count many times. When
  several verified Zaps carry the same `payment_hash`, exactly one enters
  totals, chosen deterministically (lowest `ms`, then lowest rumor id) so all
  members agree.

The `e`-referenced message MAY be one the receiver has not yet seen — a Zap is
held and folded when its target arrives, exactly as a reaction to an unseen
message is. A client MAY render an event that fails the payment or amount check
as an unverified claim, but it never enters totals.

**What the proof does and does not bind.** Invoice + preimage prove that *this
invoice was settled for this amount* — value verifiably moved, exactly once
per Channel (the uniqueness rule). They do not cryptographically prove the
invoice credited the `p`-tagged recipient, or that the seal's signer was the
one who paid: a custodial provider's invoice does not name its account holder,
any LNURL endpoint will happily issue an invoice, and a preimage learned
out-of-band could be announced in a Channel that never saw the original. Those
links are the payer's word, carried by their real signature on the seal — the
same authorship trust every message in the plane already rests on — backed by
economics: fabricating a Zap means actually paying the claimed sats to
someone, so within a Channel a forger can misattribute value but never mint
it. Totals stay honest in aggregate the way proof-of-burn is honest.

### 5. Privacy

The entire zap — who zapped, what was zapped, in which community, the comment —
exists only inside the sealed plane. What leaks, and to whom:

- **The provider** (recipient's Lightning wallet) learns that *someone* paid an
  invoice of some amount at some time — exactly what it learns from any
  Lightning payment, Nostr or not. It sees no Nostr key, no event id, no
  community. The LNURL fetch does expose the payer's IP to the provider, as
  every LNURL payment does; a client MAY route it through a proxy.
- **Relays and the public network** see nothing: no kind `9734` is ever created,
  no kind `9735` is ever published, and the sealed Zap rumor is indistinguishable
  from any other stream traffic (CORD-01).
- **Timing** is the residual channel: a provider that also observes the
  Community's relays could correlate an invoice's settlement time with a wrap's
  `created_at`. This is the same order of leak as message timing itself and
  carries the same answer — it identifies *that* traffic exists, not what or
  whose.

### 6. Wallet support

Because the proof comes from the payer's wallet, the wallet MUST surface the
preimage — via the `pay_invoice` reply, or a follow-up `lookup_invoice`. Most
NWC wallets do (Alby Hub, Coinos, lnbits); some (e.g. cashu.me) never expose it,
and there a private zap cannot be recorded even though the payment settles. A
client SHOULD tell the user the payment went through but no tally could be
posted, rather than reporting a failure.

### Appendix: the rejected alternative

A provider-attested variant was considered: sign a NIP-57 kind `9734` request
with an **ephemeral** key (so the provider cannot identify the payer) and list
the Community's own relays, letting the provider publish its ordinary public
`9735` there for members to verify against the provider's `nostrPubkey`. It works
with existing providers and yields a stronger recipient binding — but the
receipt is still a public event carrying the recipient, the amount, the time,
and an (opaque) event id, published to relays that advertise themselves as the
community's home. A sealed plane should not emit a beacon per zap. The preimage
proof keeps verification local and the network silent; the weaker recipient
binding is priced in §4. Should a future need arise, an attested mode can be
added additively (a marker tag on the same kind) without disturbing this
convention.

### Implementation

In the Armada client:

- `client/src/lib/zaps.ts` — `verifyZapRumor` (the §4 proof check), tag builder,
  and bolt11 decoding.
- `client/src/hooks/useZap.ts` + `client/src/lib/lnurl.ts` — the §2 flow
  (LNURL-pay without the `nostr` or `comment` parameters, pay, obtain
  preimage).
- `client/src/concord-v2/lib/chat.ts` — folds verified Zaps into per-message
  tallies, one per `payment_hash` (§4 uniqueness); unverified ones never enter
  totals.
- `client/src/concord-v2/hooks/useTransport2.ts` — seals and publishes the Zap
  rumor (`sendZap`).
