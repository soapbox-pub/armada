import { Loader2, Plus, Shield } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { field, GROUP_LABEL, type Surface } from "@/concord/components/channelEditor/editorStyles";
import type { EditorModel } from "@/concord/components/channelEditor/useChannelEditor";
import { FormattedMessage, useIntl } from "@/i18n";

/** Who reads a Channel on a legacy Roster: every member, or the holders of its access Roles. */
export function EditorLegacyAccess({ model, surface }: { model: EditorModel; surface: Surface }) {
  const intl = useIntl();
  const [roleName, setRoleName] = useState("");
  const mint = model.mintAccessRole;

  if (!model.values.isPrivate) {
    return (
      <p className="text-sm text-muted-foreground">
        <FormattedMessage
          id="channelEditor.legacy.public"
          defaultMessage="Readable by every member. Making a channel private needs the community on ranked roles."
        />
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <div className={GROUP_LABEL}>
        <FormattedMessage id="channelEditor.legacy.roles" defaultMessage="Access roles" />
      </div>
      {model.accessRoles.length > 0 ? (
        <ul className="space-y-1">
          {model.accessRoles.map((role) => (
            <li key={role.id} className="flex items-center gap-2 text-sm font-medium">
              <Shield className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{role.name}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          <FormattedMessage
            id="channelEditor.legacy.noRole"
            defaultMessage="No role is scoped to this channel, so only the owner and existing key holders can read it."
          />
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        <FormattedMessage
          id="channelEditor.legacy.grantHint"
          defaultMessage="Grant one of these roles to give a member access; revoking it rotates the key away."
        />
      </p>
      {mint && (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const name = roleName.trim();
            if (!name) return;
            void mint(name).then((ok) => ok && setRoleName(""));
          }}
        >
          <Input
            value={roleName}
            onChange={(e) => setRoleName(e.target.value)}
            disabled={model.busy}
            autoComplete="off"
            aria-label={intl.formatMessage({ id: "channelEditor.legacy.newRoleName", defaultMessage: "New access role name" })}
            placeholder={intl.formatMessage({ id: "channelEditor.legacy.newRoleName", defaultMessage: "New access role name" })}
            className={field(surface)}
          />
          <Button type="submit" variant="secondary" className="shrink-0 clip-corner-lg" disabled={model.busy || !roleName.trim()}>
            {model.busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            <FormattedMessage id="channelEditor.legacy.createRole" defaultMessage="Create role" />
          </Button>
        </form>
      )}
    </div>
  );
}
