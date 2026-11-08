import { Loader2, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { ChromeDialogContent, ChromeDialogFooter, ChromeDialogHeader, Dialog } from "@/components/ui/dialog";

import { ChannelPermissionsDialog } from "@/concord/components/ChannelPermissionsDialog";
import { useRankedRoles } from "@/concord/hooks/useRankedRoles";
import { categoryOrder } from "@/concord/lib/rankedWrites";
import { isAuthorized, Permissions } from "@/concord/lib/roles";
import type { Community } from "@/concord/lib/types";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { toast } from "@/hooks/useToast";
import { common, FormattedMessage, t, useIntl } from "@/i18n";

type Scope = { idHex: string; kind: "channel" | "category"; name: string };

/**
 * The vsk-13 Category and permission actions a channel list offers (CORD-03 §4,
 * CORD-04 §8): reorder, delete, and the permissions dialog for a Category or a
 * Channel. Everything is absent on the legacy Roster.
 */
export function useRankedCategoryControls(community: Community | undefined, canManageChannels: boolean) {
  const intl = useIntl();
  const { user } = useCurrentUser();
  const { folded, moveCategory, deleteCategory } = useRankedRoles(community);
  const [scope, setScope] = useState<Scope | undefined>(undefined);
  const [deleting, setDeleting] = useState<{ idHex: string; name: string } | undefined>(undefined);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const ranked = folded?.rankedRoster === true;
  const canManageRoles = Boolean(ranked && user && folded && isAuthorized(folded.roster, user.pubkey, folded.ownerHex, Permissions.MANAGE_ROLES));
  const order = useMemo(() => (ranked && folded ? categoryOrder(folded) : []), [ranked, folded]);

  const run = (p: Promise<unknown>, fallback: string) =>
    void p.catch((e: unknown) => toast({ title: fallback, description: e instanceof Error ? e.message : undefined, variant: "destructive" }));

  /** The heading actions for the Category keyed `key` (its id on the vsk-13 Roster). */
  const actionsFor = (key: string, name: string) => {
    const index = order.findIndex((c) => c.idHex === key);
    if (index < 0) return {};
    const moveFailed = t({ id: "rankedCategory.moveFailed", defaultMessage: "Couldn't move the category" });
    return {
      onMoveUp: canManageChannels && index > 0 ? () => run(moveCategory({ idHex: key, index: index - 1 }), moveFailed) : undefined,
      onMoveDown: canManageChannels && index < order.length - 1 ? () => run(moveCategory({ idHex: key, index: index + 1 }), moveFailed) : undefined,
      onPermissions: canManageRoles ? () => setScope({ idHex: key, kind: "category", name }) : undefined,
      onDelete: canManageChannels ? () => setDeleting({ idHex: key, name }) : undefined,
    };
  };

  const openChannelPermissions = useCallback((channel: { idHex: string; name: string }) => setScope({ idHex: channel.idHex, kind: "channel", name: channel.name }), []);

  const confirmDelete = () => {
    if (!deleting) return;
    setDeleteBusy(true);
    setDeleteError(null);
    deleteCategory({ idHex: deleting.idHex })
      .then(() => setDeleting(undefined))
      .catch((e: unknown) => setDeleteError(e instanceof Error ? e.message : t({ id: "rankedCategory.deleteFailed", defaultMessage: "Couldn't delete the category" })))
      .finally(() => setDeleteBusy(false));
  };

  const closeDelete = () => {
    if (deleteBusy) return;
    setDeleting(undefined);
    setDeleteError(null);
  };

  const dialog = community ? (
    <>
      <ChannelPermissionsDialog community={community} scope={scope} onOpenChange={(open) => !open && setScope(undefined)} />
      <Dialog open={Boolean(deleting)} onOpenChange={(open) => !open && closeDelete()}>
        <ChromeDialogContent
          title={intl.formatMessage({ id: "rankedCategory.deleteTitle", defaultMessage: "Delete {name}?" }, { name: deleting?.name ?? "" })}
          className="sm:max-w-sm"
        >
          <ChromeDialogHeader
            icon={Trash2}
            tone="destructive"
            title={intl.formatMessage({ id: "rankedCategory.deleteHeading", defaultMessage: "delete {name}?" }, { name: deleting?.name ?? "" })}
            description={intl.formatMessage({
              id: "rankedCategory.deleteBody",
              defaultMessage: "Its channels stay, outside any category. Deleting a category can't be undone.",
            })}
          />
          {deleteError && <p className="mt-3 text-sm text-destructive">{deleteError}</p>}
          <ChromeDialogFooter>
            <Button type="button" variant="ghost" onClick={closeDelete} disabled={deleteBusy}>
              <FormattedMessage {...common.cancel} />
            </Button>
            <Button type="button" variant="destructive" onClick={confirmDelete} disabled={deleteBusy}>
              {deleteBusy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
              <FormattedMessage id="channelCategoryHeading.delete" defaultMessage="Delete category" />
            </Button>
          </ChromeDialogFooter>
        </ChromeDialogContent>
      </Dialog>
    </>
  ) : null;

  return {
    ranked,
    categories: order,
    actionsFor,
    openChannelPermissions: canManageRoles ? openChannelPermissions : undefined,
    openCategoryPermissions: canManageRoles ? (idHex: string, name: string) => setScope({ idHex, kind: "category", name }) : undefined,
    dialog,
  };
}
