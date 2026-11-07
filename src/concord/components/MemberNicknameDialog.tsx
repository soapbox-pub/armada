import { Tag } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { useAuthor } from "@/hooks/useAuthor";
import { getDisplayName } from "@/lib/getDisplayName";
import { Dialog, ChromeDialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cleanNickname, NICKNAME_MAX_CHARS } from "@/concord/lib/guestbook";
import { common, FormattedMessage, useIntl } from "@/i18n";

/** Set the Nickname a member goes by in this Community (CORD-04 §10); empty clears it. */
export function MemberNicknameDialog({
  open,
  self,
  pubkey,
  initial,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  /** Whether the member is the one setting it. */
  self: boolean;
  pubkey: string;
  initial: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (nick: string) => Promise<void>;
}) {
  const intl = useIntl();
  const name = getDisplayName(useAuthor(pubkey).data?.metadata, pubkey);
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setValue(initial);
      setError(null);
    }
  }, [open, initial]);

  const clean = cleanNickname(value);
  const unchanged = clean === initial.trim();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent title={intl.formatMessage({ id: "memberNicknameDialog.title", defaultMessage: "Change nickname" })}>
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex size-12 items-center justify-center clip-corner-lg bg-primary/15 text-primary">
            <Tag className="size-6" />
          </div>
          <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground">
            <FormattedMessage id="memberNicknameDialog.heading" defaultMessage="change nickname" />
          </h2>
          <p className="text-sm text-muted-foreground">
            {self
              ? <FormattedMessage id="memberNicknameDialog.selfDescription" defaultMessage="The name you go by in this community. Leave it empty to go by your profile name." />
              : <FormattedMessage id="memberNicknameDialog.otherDescription" defaultMessage="The name {name} goes by in this community. Leave it empty to clear it." values={{ name }} />}
          </p>
        </div>

        <form
          className="mt-6 space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (clean === undefined || unchanged) {
              onOpenChange(false);
              return;
            }
            setSaving(true);
            setError(null);
            onSubmit(clean)
              .then(() => onOpenChange(false))
              .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
              .finally(() => setSaving(false));
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="member-nickname" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <FormattedMessage id="memberNicknameDialog.label" defaultMessage="Nickname" />
            </Label>
            <Input
              id="member-nickname"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={name}
              autoComplete="off"
              autoFocus
              maxLength={NICKNAME_MAX_CHARS * 2}
              className="bg-background/40 border-transparent"
            />
            {clean === undefined && (
              <p className="text-xs text-destructive">
                <FormattedMessage id="memberNicknameDialog.invalid" defaultMessage="At most {max} characters, with no line breaks." values={{ max: NICKNAME_MAX_CHARS }} />
              </p>
            )}
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>

          <div className="flex items-center gap-2 pt-1">
            <Button type="button" variant="ghost" className="flex-1 clip-corner-lg" onClick={() => onOpenChange(false)}>
              <FormattedMessage {...common.cancel} />
            </Button>
            <Button type="submit" className="flex-1 clip-corner-lg" disabled={clean === undefined || unchanged || saving}>
              <FormattedMessage {...common.save} />
            </Button>
          </div>
        </form>
      </ChromeDialogContent>
    </Dialog>
  );
}
