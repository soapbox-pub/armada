import { EmojifiedText } from "@/components/chat/CustomEmoji";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedIdentity } from "@/hooks/useScopedDisplayName";
import { isAnonymousName } from "@/lib/getDisplayName";
import { anonymousTag, pubkeyHue, pubkeyHueColor } from "@/lib/pubkeyHue";

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
 * A nameless person gets their {@link anonymousTag} after it, in their avatar's hue.
 */
export function DisplayName(props: DisplayNameProps) {
  if (props.name !== undefined && (props.tags !== undefined || props.pubkey === undefined)) {
    return (
      <>
        <EmojifiedText tags={props.tags ?? NO_TAGS} imgClassName={props.imgClassName}>
          {props.name}
        </EmojifiedText>
        <AnonymousTag name={props.name} pubkey={props.pubkey} />
      </>
    );
  }
  return <ResolvedDisplayName {...props} />;
}

/** Its own styled element, so a name typed as "Anonymous#1a2b" still reads as typed text. */
function AnonymousTag({ name, pubkey }: { name: string; pubkey: string | undefined }) {
  if (!isAnonymousName(name)) return null;
  const hue = pubkeyHue(pubkey);
  if (hue === undefined || !pubkey) return null;
  return (
    <span className="font-mono font-normal" style={{ color: pubkeyHueColor(hue) }}>
      {anonymousTag(pubkey)}
    </span>
  );
}

const NO_TAGS: string[][] = [];

function ResolvedDisplayName({ pubkey, name, imgClassName }: DisplayNameProps) {
  const author = useAuthor(pubkey);
  const scoped = useScopedIdentity(pubkey, author.data?.metadata);

  const shown = name ?? scoped.displayName;
  return (
    <>
      <EmojifiedText tags={author.data?.event?.tags ?? []} imgClassName={imgClassName}>
        {shown}
      </EmojifiedText>
      <AnonymousTag name={shown} pubkey={pubkey} />
    </>
  );
}
