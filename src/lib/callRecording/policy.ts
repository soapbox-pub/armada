import type { VoiceIdentityResolver } from "@/contexts/VoiceIdentityContext";
import type { RecordingSource } from "@/lib/callRecording/engine";

export interface PolicyParticipant {
  identity: string;
  isLocal: boolean;
  /** The decoded (remote) or published (local) microphone track, if any. */
  micTrack: MediaStreamTrack | undefined;
}

/**
 * Whose voice may go into the recording. Default deny: only a VERIFIED member
 * is recorded, because verification is a fresh signed presence — the same
 * rumor that would carry their `norecord`. A participant whose presence has
 * not arrived, is contested, or is a screen-share sidecar is never captured,
 * and one who refuses is dropped the moment their presence says so. Nor is one the
 * call does not hear (`speaks`: server-muted, timed out, without SPEAK), whatever
 * their client keeps sending.
 */
export function recordableSources(
  participants: readonly PolicyParticipant[],
  resolve: VoiceIdentityResolver,
  refusing: ReadonlySet<string>,
  titleOf: (pubkey: string) => string,
  speaks: (pubkey: string) => boolean = () => true,
): RecordingSource[] {
  const out: RecordingSource[] = [];
  const seen = new Set<string>();
  // The local participant first, so our own device wins a pubkey we share with another.
  const ordered = [...participants].sort((a, b) => Number(b.isLocal) - Number(a.isLocal));
  for (const p of ordered) {
    if (!p.identity || !p.micTrack || p.micTrack.readyState === "ended") continue;
    const { pubkey, verified, role } = resolve(p.identity);
    if (!verified || role !== "member" || refusing.has(pubkey) || seen.has(pubkey) || !speaks(pubkey)) continue;
    seen.add(pubkey);
    out.push({ key: pubkey, title: titleOf(pubkey), track: p.micTrack });
  }
  return out;
}
