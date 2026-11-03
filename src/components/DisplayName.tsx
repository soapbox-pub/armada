import { EmojifiedText } from "@/components/chat/CustomEmoji";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedIdentity } from "@/hooks/useScopedDisplayName";
import { isAnonymousName } from "@/lib/getDisplayName";
import { useProfilePending } from "@/lib/profileLoading";
import { anonymousTag, pubkeyHue, pubkeyHueTagColor } from "@/lib/pubkeyHue";

interface DisplayNameProps {
  pubkey: string | undefined;
  /** Overrides the resolved name. Custom emoji still come from the pubkey's kind-0 tags. */
  name?: string;
  imgClassName?: string;
  /** The caller's kind-0 tags; with `name` too, no profile queries subscribe (matters on timelines). */
  tags?: string[][];
}

/**
 * Scoped display name with NIP-30 emoji shortcodes rendered as images. Emits
 * no wrapper element. For plain strings use {@link useScopedDisplayName}.
 * A nameless person gets their {@link anonymousTag} after it, in a dimmed shade of their avatar's hue,
 * or a skeleton while their profile is still loading.
 */
export function DisplayName(props: DisplayNameProps) {
  if (props.name !== undefined && (props.tags !== undefined || props.pubkey === undefined)) {
    return <NameText name={props.name} pubkey={props.pubkey} tags={props.tags ?? NO_TAGS} imgClassName={props.imgClassName} />;
  }
  return <ResolvedDisplayName {...props} />;
}

function NameText({ name, pubkey, tags, imgClassName }: {
  name: string;
  pubkey: string | undefined;
  tags: string[][];
  imgClassName?: string;
}) {
  const anonymous = isAnonymousName(name);
  const pending = useProfilePending(anonymous ? pubkey : undefined);
  if (pending) return <NameSkeleton />;
  return (
    <>
      <EmojifiedText tags={tags} imgClassName={imgClassName}>
        {name}
      </EmojifiedText>
      {anonymous && <AnonymousTag name={name} pubkey={pubkey} />}
    </>
  );
}

/** Text-sized, so it sits in a line of text or a heading alike. */
export function NameSkeleton() {
  return (
    <span
      aria-hidden
      className="inline-block h-[0.8em] w-[6em] max-w-full animate-pulse rounded-sm bg-muted align-[-0.05em] [animation-iteration-count:8]"
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

function ResolvedDisplayName({ pubkey, name, imgClassName }: DisplayNameProps) {
  const author = useAuthor(pubkey);
  const scoped = useScopedIdentity(pubkey, author.data?.metadata);

  return (
    <NameText
      name={name ?? scoped.displayName}
      pubkey={pubkey}
      tags={author.data?.event?.tags ?? NO_TAGS}
      imgClassName={imgClassName}
    />
  );
}
