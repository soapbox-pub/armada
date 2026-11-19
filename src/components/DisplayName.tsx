import type { NostrMetadata } from "@nostrify/nostrify";

import { EmojifiedText } from "@/components/chat/CustomEmoji";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedIdentity } from "@/hooks/useScopedDisplayName";
import { isAnonymousName } from "@/lib/getDisplayName";
import { useProfilePending } from "@/lib/profileLoading";
import { anonymousTag, pubkeyHue, pubkeyHueTagColor } from "@/lib/pubkeyHue";
import { nameStyleCss, useUltra, ULTRA_LIST_NAME_CLASS, ULTRA_NAME_CLASS, type NameStyleId } from "@/lib/ultra";

interface DisplayNameProps {
  pubkey: string | undefined;
  /** Overrides the resolved name. Custom emoji still come from the pubkey's kind-0 tags. */
  name?: string;
  imgClassName?: string;
  /** The caller's kind-0 tags; with `name` too, no profile queries subscribe (matters on timelines). */
  tags?: string[][];
  /** The caller's kind-0, read for its Ultra name style alongside `name` and `tags`. */
  metadata?: NostrMetadata;
  /**
   * The Ultra name style: `"list"` (the default) drifts twice and holds, for
   * rows that repeat; `"hero"` loops, for a name shown on its own; `false`
   * draws none, where the name sits in running text or another color owns it.
   */
  ultra?: UltraNameMode;
}

export type UltraNameMode = "list" | "hero" | false;

/**
 * Scoped display name with NIP-30 emoji shortcodes rendered as images, in the
 * person's Ultra name style (the one place it is drawn). Emits no wrapper
 * element unless styled. For plain strings use {@link useScopedDisplayName}.
 * A nameless person gets their {@link anonymousTag} after it, in a dimmed shade of their avatar's hue,
 * or a skeleton while their profile is still loading.
 */
export function DisplayName(props: DisplayNameProps) {
  if (props.name !== undefined && (props.tags !== undefined || props.pubkey === undefined)) {
    return <PreparedName {...props} name={props.name} />;
  }
  return <ResolvedDisplayName {...props} />;
}

function PreparedName({ name, pubkey, tags, imgClassName, metadata, ultra = "list" }: DisplayNameProps & { name: string }) {
  const style = useUltra(ultra ? metadata : undefined)?.name;
  return <NameText name={name} pubkey={pubkey} tags={tags ?? NO_TAGS} imgClassName={imgClassName} style={style} mode={ultra} />;
}

function NameText({ name, pubkey, tags, imgClassName, style, mode }: {
  name: string;
  pubkey: string | undefined;
  tags: string[][];
  imgClassName?: string;
  style: NameStyleId | undefined;
  mode: UltraNameMode;
}) {
  const anonymous = isAnonymousName(name);
  const pending = useProfilePending(anonymous ? pubkey : undefined);
  if (pending) return <NameSkeleton />;
  const text = (
    <EmojifiedText tags={tags} imgClassName={imgClassName}>
      {name}
    </EmojifiedText>
  );
  return (
    <>
      {style && mode ? (
        <span className={mode === "hero" ? ULTRA_NAME_CLASS : ULTRA_LIST_NAME_CLASS} style={nameStyleCss(style)}>
          {text}
        </span>
      ) : text}
      {anonymous && <AnonymousTag name={name} pubkey={pubkey} />}
    </>
  );
}

/** Text-sized, so it sits in a line of text or a heading alike. */
export function NameSkeleton() {
  return (
    <span
      aria-hidden
      className="inline-block h-[0.8em] w-[6em] max-w-full animate-pulse rounded-sm bg-muted align-[-0.05em]"
    />
  );
}

/** Its own styled element, so a name typed as "Anonymous#1a2b" still reads as typed text. */
function AnonymousTag({ name, pubkey }: { name: string; pubkey: string | undefined }) {
  if (!isAnonymousName(name)) return null;
  const hue = pubkeyHue(pubkey);
  if (hue === undefined || !pubkey) return null;
  return (
    <span className="font-mono font-normal" style={{ color: pubkeyHueTagColor(hue) }}>
      {anonymousTag(pubkey)}
    </span>
  );
}

const NO_TAGS: string[][] = [];

function ResolvedDisplayName({ pubkey, name, imgClassName, ultra = "list" }: DisplayNameProps) {
  const author = useAuthor(pubkey);
  const scoped = useScopedIdentity(pubkey, author.data?.metadata);
  const style = useUltra(ultra ? author.data?.metadata : undefined)?.name;

  return (
    <NameText
      name={name ?? scoped.displayName}
      pubkey={pubkey}
      tags={author.data?.event?.tags ?? NO_TAGS}
      imgClassName={imgClassName}
      style={style}
      mode={ultra}
    />
  );
}
