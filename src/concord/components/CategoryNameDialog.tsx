import { Folder } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, ChromeDialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NAME_MAX_BYTES } from "@/concord/lib/types";
import { common, FormattedMessage, useIntl } from "@/i18n";

/**
 * Name a channel category (create or rename). On the legacy Roster a category is
 * only the channels naming it, so rename re-files each one; on the vsk-13 Roster
 * (`ranked`) it is an entity of its own (CORD-03 §4), renamed in place.
 */
export function CategoryNameDialog({
  open,
  initial,
  count,
  onOpenChange,
  onSubmit,
  ranked = false,
}: {
  open: boolean;
  initial: string;
  count: number;
  onOpenChange: (open: boolean) => void;
  onSubmit: (name: string) => void;
  ranked?: boolean;
}) {
  const intl = useIntl();
  const [value, setValue] = useState(initial);
  useEffect(() => {
    if (open) setValue(initial);
  }, [open, initial]);

  const trimmed = value.trim();
  const unchanged = trimmed === initial.trim();
  const renaming = Boolean(initial);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent title={renaming
        ? intl.formatMessage({ id: "categoryNameDialog.renameTitle", defaultMessage: "Rename category" })
        : intl.formatMessage({ id: "categoryNameDialog.newTitle", defaultMessage: "New category" })}>
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex size-12 items-center justify-center clip-corner-lg bg-primary/15 text-primary">
            <Folder className="size-6" />
          </div>
          <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground">
            {renaming
              ? <FormattedMessage id="categoryNameDialog.renameHeading" defaultMessage="rename category" />
              : <FormattedMessage id="categoryNameDialog.newHeading" defaultMessage="new category" />}
          </h2>
          <p className="text-sm text-muted-foreground">
            {ranked
              ? renaming
                ? <FormattedMessage id="categoryNameDialog.renameRanked" defaultMessage="Renames the category for everyone. Its channels and permissions stay as they are." />
                : <FormattedMessage id="categoryNameDialog.newRanked" defaultMessage="A heading to group channels under in the sidebar, with permissions its channels can follow." />
              : renaming
              ? count > 1
                ? <FormattedMessage id="categoryNameDialog.renameMany" defaultMessage="Renames the category for all {count} channels in it." values={{ count }} />
                : <FormattedMessage id="categoryNameDialog.renameOne" defaultMessage="A category is only ever the channels naming it, so renaming re-files the channel in it." />
              : <FormattedMessage id="categoryNameDialog.newDescription" defaultMessage="A heading to group channels under in the sidebar. It exists for as long as a channel is in it." />}
          </p>
        </div>

        <form
          className="mt-6 space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!trimmed || unchanged) {
              onOpenChange(false);
              return;
            }
            onSubmit(trimmed);
            onOpenChange(false);
          }}
        >
          <div className="space-y-1.5">
            <Label
              htmlFor="channel-category-name"
              className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              <FormattedMessage id="categoryNameDialog.nameLabel" defaultMessage="Category name" />
            </Label>
            <Input
              id="channel-category-name"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={intl.formatMessage({ id: "categoryNameDialog.namePlaceholder", defaultMessage: "e.g. Voice" })}
              autoComplete="off"
              autoFocus
              maxLength={NAME_MAX_BYTES}
              className="bg-background/40 border-transparent"
            />
          </div>

          <div className="flex items-center gap-2 pt-1">
            <Button
              type="button"
              variant="ghost"
              className="flex-1 clip-corner-lg"
              onClick={() => onOpenChange(false)}
            >
              <FormattedMessage {...common.cancel} />
            </Button>
            <Button type="submit" className="flex-1 clip-corner-lg" disabled={!trimmed || unchanged}>
              {renaming
                ? <FormattedMessage id="categoryNameDialog.rename" defaultMessage="Rename" />
                : <FormattedMessage {...common.create} />}
            </Button>
          </div>
        </form>
      </ChromeDialogContent>
    </Dialog>
  );
}
