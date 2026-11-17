import { useEffect, useState } from "react";

import { ChromeDialogContent, Dialog } from "@/components/ui/dialog";
import { editorMessages as m } from "@/concord/components/channelEditor/editorMessages";
import { EditorPane } from "@/concord/components/channelEditor/EditorPane";
import { EditorSheet } from "@/concord/components/channelEditor/EditorSheet";
import type { Surface } from "@/concord/components/channelEditor/editorStyles";
import { useChannelEditor, type EditorOps, type EditorScope } from "@/concord/components/channelEditor/useChannelEditor";
import type { Community } from "@/concord/lib/types";
import { useIsTouch } from "@/hooks/useIsMobile";
import { FormattedMessage } from "@/i18n";

const scopeId = (scope: EditorScope) => `${scope.kind}:${scope.idHex}`;

function Overlay({
  community,
  scope,
  ops,
  open,
  onClose,
}: {
  community: Community;
  scope: EditorScope;
  ops?: EditorOps;
  open: boolean;
  onClose: () => void;
}) {
  const touch = useIsTouch();
  const model = useChannelEditor(community, scope, ops);
  // Deleted from elsewhere while open: there is nothing left to edit.
  const [seen, setSeen] = useState(false);
  if (!model.missing && !seen) setSeen(true);
  const gone = seen && model.missing;
  useEffect(() => {
    if (gone && open) onClose();
  }, [gone, open, onClose]);

  if (touch) return <EditorSheet model={model} open={open} onOpenChange={(next) => !next && onClose()} />;
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <ChromeDialogContent title={model.base.name} className="sm:max-w-3xl" contentClassName="flex max-h-[85dvh] flex-col" hideClose>
        <EditorPane model={model} surface="chrome" onDone={onClose} onCancel={onClose} />
      </ChromeDialogContent>
    </Dialog>
  );
}

/**
 * The Channel or Category editor over the page: a bottom sheet on touch, a
 * dialog otherwise. Closing it discards what wasn't saved.
 */
export function ChannelEditor({
  community,
  scope,
  ops,
  onClose,
}: {
  community: Community;
  /** What is being edited; undefined while closed. */
  scope: EditorScope | undefined;
  ops?: EditorOps;
  onClose: () => void;
}) {
  // Mounted from the first opening on, kept while it animates closed, and remounted per opening so a dismissed draft is gone.
  const [session, setSession] = useState<{ scope: EditorScope; n: number; open: boolean } | undefined>(
    scope ? { scope, n: 0, open: true } : undefined,
  );
  if (scope ? !session?.open || scopeId(scope) !== scopeId(session.scope) : session?.open) {
    setSession(scope ? { scope, n: (session?.n ?? 0) + 1, open: true } : session && { ...session, open: false });
  }
  if (!session) return null;
  return <Overlay key={session.n} community={community} scope={session.scope} ops={ops} open={Boolean(scope)} onClose={onClose} />;
}

/** The editor in the page, beside the list its scope was picked from. It stays after a save. */
export function ChannelEditorPane({
  community,
  scope,
  ops,
  surface = "background",
  className,
  onRemoved,
  onDirtyChange,
}: {
  community: Community;
  scope: EditorScope;
  ops?: EditorOps;
  surface?: Surface;
  className?: string;
  onRemoved: () => void;
  /** Unsaved changes would be lost by showing another scope. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const model = useChannelEditor(community, scope, ops);
  const { dirty } = model;
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  if (model.missing) {
    return (
      <p className="py-6 text-sm text-muted-foreground">
        <FormattedMessage {...m.missing} values={{ scope: scope.kind }} />
      </p>
    );
  }
  return <EditorPane model={model} surface={surface} onDone={(reason) => reason === "removed" && onRemoved()} onCancel={model.reset} inline className={className} />;
}
