import { ChevronRight, Folder, FolderX, KeyRound, Loader2, Plus, RefreshCw, RotateCw, SlidersHorizontal, Trash2 } from "lucide-react";
import { useId, useMemo, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { PillTabs, type PillTab } from "@/components/ui/pill-tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { AccessReviewDialog } from "@/concord/components/accessReview/AccessReviewDialog";
import { ChannelGlyph } from "@/concord/components/ChannelGlyph";
import { EditorLegacyAccess } from "@/concord/components/channelEditor/EditorLegacyAccess";
import { editorMessages as m } from "@/concord/components/channelEditor/editorMessages";
import { ConfirmText, EditorField, GeneralFields, RuleGroups, TargetLabel, TargetLead, TargetPicker, TargetSummary } from "@/concord/components/channelEditor/editorParts";
import { field, GROUP_LABEL, type Surface } from "@/concord/components/channelEditor/editorStyles";
import type { EditorModel, EditorTab } from "@/concord/components/channelEditor/useChannelEditor";
import { useEditorFlow } from "@/concord/components/channelEditor/useEditorFlow";
import { WriteProgress } from "@/concord/components/WriteProgress";
import { common, FormattedMessage, useIntl } from "@/i18n";
import { cn } from "@/lib/utils";

/** Radix Select has no empty value. */
const NO_CATEGORY = "none";

const CARD = "rounded-lg bg-secondary/40";

function SwitchCardRow({
  title,
  hint,
  checked,
  onCheckedChange,
  disabled,
}: {
  title: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className={cn("flex cursor-pointer items-center gap-3 p-3", disabled && "opacity-50")}>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
    </label>
  );
}

const CardDivider = () => <div role="separator" className="mx-3 h-px bg-foreground/10" />;

/**
 * The Channel and Category editor laid out for a pointer: fields on one tab,
 * and on the other the Roles and members beside the selected one's rule.
 */
export function EditorPane({
  model,
  surface,
  onDone,
  onCancel,
  inline = false,
  className,
}: {
  model: EditorModel;
  surface: Surface;
  onDone: (reason: "saved" | "removed") => void;
  onCancel: () => void;
  /** Shown in the page rather than over it: Cancel only has a draft to drop. */
  inline?: boolean;
  className?: string;
}) {
  const intl = useIntl();
  const { scope, values } = model;
  const isChannel = scope.kind === "channel";
  const [tab, setTab] = useState<EditorTab>(scope.tab ?? "general");
  const [selectedKey, setSelectedKey] = useState<string | undefined>(undefined);
  const [picking, setPicking] = useState(false);
  const flow = useEditorFlow(model, onDone);
  const categoryId = useId();

  const tabs = useMemo<PillTab<EditorTab>[]>(
    () => [
      { id: "general", label: intl.formatMessage(m.general), icon: SlidersHorizontal },
      { id: "permissions", label: intl.formatMessage(m.permissions), icon: KeyRound },
    ],
    [intl],
  );

  const selected = model.targets.find((t) => t.key === selectedKey) ?? model.targets[0];

  const targets = (
    <div className="space-y-2">
      <div className={GROUP_LABEL}>
        <FormattedMessage {...m.targets} />
      </div>
      {model.unkeyed && model.canManageRoles && (
        <p className="text-xs text-muted-foreground">
          <FormattedMessage {...m.unkeyed} />
        </p>
      )}
      <div className={cn("space-y-1 p-1", CARD)}>
        {model.targets.map((target) => (
          <button
            key={target.key}
            type="button"
            aria-pressed={!picking && selected?.key === target.key}
            onClick={() => {
              setSelectedKey(target.key);
              setPicking(false);
            }}
            className={cn(
              "flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-secondary/70",
              !picking && selected?.key === target.key && "bg-secondary",
            )}
          >
            <TargetLead target={target} variant="pane" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              <TargetLabel target={target} />
            </span>
            <span className="shrink-0 text-2xs text-muted-foreground">
              <TargetSummary view={target.view} others={target.others} />
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground/50" />
          </button>
        ))}
      </div>
      {model.canManageRoles && (
        <Button type="button" variant="secondary" className="w-full clip-corner-lg" disabled={model.busy || model.unkeyed} onClick={() => setPicking(true)}>
          <Plus className="size-4" />
          <FormattedMessage {...m.addTarget} />
        </Button>
      )}
    </div>
  );

  const rule = picking ? (
    <div className="space-y-3">
      <div className="flex h-[1.125rem] items-center text-sm font-semibold">
        <FormattedMessage {...m.addTarget} />
      </div>
      <TargetPicker
        model={model}
        variant="pane"
        onDone={(added) => {
          if (added) setSelectedKey(added);
          setPicking(false);
        }}
      />
    </div>
  ) : selected ? (
    <div className="space-y-3">
      <div className="flex h-[1.125rem] items-center gap-2">
        <span className="min-w-0 truncate text-sm font-semibold">
          <TargetLabel target={selected} />
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          <FormattedMessage {...m.ruleContext} values={{ scope: scope.kind, name: model.base.name }} />
        </span>
        {selected.kind !== "everyone" && model.canManageRoles && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="clip-corner-lg text-destructive hover:text-destructive"
            disabled={model.busy || selected.reach === 0n}
            onClick={() => {
              model.removeTarget(selected.key);
              setSelectedKey(undefined);
            }}
          >
            <FormattedMessage {...common.remove} />
          </Button>
        )}
      </div>
      <RuleGroups model={model} target={selected} variant="pane" />
    </div>
  ) : null;

  const rotate = model.rotateKey && (
    <div className={cn("flex items-center gap-3 p-3", CARD)}>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">
          <FormattedMessage {...m.rotate} />
        </span>
        <span className="block text-xs text-muted-foreground">
          <FormattedMessage {...m.rotateHint} />
        </span>
      </span>
      <Button type="button" variant="secondary" size="sm" className="clip-corner-lg" disabled={model.busy || model.dirty} onClick={() => flow.ask("rotate")}>
        <RotateCw className="size-4" />
        <FormattedMessage {...m.rotate} />
      </Button>
    </div>
  );

  const privateRow = (
    <SwitchCardRow
      title={<FormattedMessage {...m.private} />}
      hint={<FormattedMessage {...m.privateHint} />}
      checked={values.isPrivate}
      onCheckedChange={model.setPrivate}
      disabled={!model.canManageChannels || model.busy || (!model.ranked && !model.base.isPrivate)}
    />
  );

  const general = (
    <div className="max-w-md space-y-4">
      <GeneralFields model={model} surface={surface} />
      {isChannel && (model.categories.length > 0 || values.category !== undefined) && (
        <EditorField htmlFor={categoryId} label={<FormattedMessage {...m.category} />}>
          <Select
            value={values.category ?? NO_CATEGORY}
            onValueChange={(key) => model.setCategory(key === NO_CATEGORY ? undefined : key)}
            disabled={!model.canManageChannels || model.busy}
          >
            <SelectTrigger id={categoryId} className={field(surface)}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_CATEGORY}>
                <FormattedMessage {...m.noCategory} />
              </SelectItem>
              {model.categories.map((c) => (
                <SelectItem key={c.key} value={c.key}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </EditorField>
      )}
    </div>
  );

  const permissions = model.ranked ? (
    <div className="grid grid-cols-1 items-start gap-6 md:grid-cols-2">
      <div className="space-y-4">
        <div className={CARD}>
          {values.category !== undefined && (
            <>
              <SwitchCardRow
                title={<FormattedMessage {...m.sync} values={{ category: model.categoryName ?? "" }} />}
                hint={<FormattedMessage {...(model.canManageRoles && !model.canSync ? m.syncRefused : m.syncHint)} />}
                checked={values.synced}
                onCheckedChange={model.setSynced}
                disabled={!model.canManageRoles || model.busy || !model.canSync}
              />
              <CardDivider />
            </>
          )}
          {privateRow}
        </div>
        {values.synced ? (
          <p className="text-sm text-muted-foreground">
            <FormattedMessage {...m.syncedNote} values={{ category: model.categoryName ?? "" }} />
          </p>
        ) : (
          targets
        )}
        {rotate}
      </div>
      {!values.synced && rule}
    </div>
  ) : (
    <div className="max-w-md space-y-4">
      <div className={CARD}>{privateRow}</div>
      <EditorLegacyAccess model={model} surface={surface} />
      {rotate}
    </div>
  );

  const category = (
    <div className="space-y-6">
      <div className="max-w-md space-y-4">
        <GeneralFields model={model} surface={surface} />
      </div>
      {model.ranked && model.canManageRoles && (
        <div className="grid grid-cols-1 items-start gap-6 md:grid-cols-2">
          <div className="space-y-4">
            {targets}
            {model.unsyncedCount > 0 && (
              <div className={cn("flex items-center gap-3 p-3", CARD)}>
                <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                  <FormattedMessage {...m.syncAllHint} values={{ count: model.unsyncedCount }} />
                  {!model.canSyncAll && (
                    <>
                      {" "}
                      <FormattedMessage {...m.syncRefused} />
                    </>
                  )}
                </span>
                <Button type="button" variant="secondary" size="sm" className="clip-corner-lg" disabled={model.busy || !model.canSyncAll} onClick={() => void model.syncAll()}>
                  <RefreshCw className="size-4" />
                  <FormattedMessage {...m.syncAll} />
                </Button>
              </div>
            )}
          </div>
          {rule}
        </div>
      )}
    </div>
  );

  return (
    <div className={cn("flex min-h-0 flex-col gap-5", className)}>
      <div className="flex min-h-10 shrink-0 items-center gap-2">
        {isChannel ? (
          <ChannelGlyph isPrivate={model.base.isPrivate} view={model.base.view} className="size-5 shrink-0 text-muted-foreground" />
        ) : (
          <Folder className="size-5 shrink-0 text-muted-foreground" />
        )}
        <h2 className="min-w-0 flex-1 truncate text-lg font-semibold leading-7 tracking-tight">{model.base.name}</h2>
        {isChannel && (
          <PillTabs
            tabs={tabs}
            value={tab}
            onChange={(id) => setTab(id)}
            labels="always"
            className={cn("w-auto shrink-0", surface === "chrome" && "bg-background/40")}
          />
        )}
      </div>

      {/* Only this scrolls where the host bounds the height; the padding keeps focus rings unclipped. */}
      <div className="-m-1 min-h-0 overflow-y-auto p-1">{!isChannel ? category : tab === "general" ? general : permissions}</div>

      {(flow.confirm || model.error || (model.saving && !flow.review)) && (
        <div className="shrink-0 space-y-2">
          {flow.confirm && (
            <p className="text-sm text-muted-foreground">
              <ConfirmText model={model} kind={flow.confirm} />
            </p>
          )}
          {model.saving && !flow.review && <WriteProgress published={model.published} planned={model.planned} />}
          {model.error && (
            <p role="alert" className="text-sm text-destructive">
              {model.error}
            </p>
          )}
        </div>
      )}

      <div className="flex shrink-0 items-center justify-end gap-2">
        {flow.confirm ? (
          <>
            <Button type="button" variant="ghost" className="clip-corner-lg" onClick={flow.dismiss}>
              <FormattedMessage {...common.back} />
            </Button>
            <Button
              type="button"
              variant={flow.confirm === "delete" ? "destructive" : "default"}
              className="clip-corner-lg"
              onClick={() => void flow.accept()}
            >
              <FormattedMessage {...common.confirm} />
            </Button>
          </>
        ) : (
          <>
            {model.canDelete && (
              <Button
                type="button"
                variant="ghost"
                className="mr-auto clip-corner-lg text-destructive hover:text-destructive"
                disabled={model.busy}
                onClick={() => flow.ask("delete")}
              >
                {isChannel ? <Trash2 className="size-4" /> : <FolderX className="size-4" />}
                <FormattedMessage {...(isChannel ? m.deleteChannel : m.deleteCategory)} />
              </Button>
            )}
            <Button type="button" variant="ghost" className="clip-corner-lg" disabled={model.saving || (inline && !model.dirty)} onClick={onCancel}>
              <FormattedMessage {...common.cancel} />
            </Button>
            <Button type="button" className="clip-corner-lg" disabled={!model.dirty || model.invalid || model.busy} onClick={flow.requestSave}>
              {model.saving && <Loader2 className="size-4 animate-spin" />}
              <FormattedMessage {...common.save} />
            </Button>
          </>
        )}
      </div>

      {flow.review && (
        <AccessReviewDialog
          subject={{ kind: "scope", label: isChannel ? `#${model.base.name}` : model.base.name }}
          review={flow.review.access}
          privacy={flow.review.privacy}
          roleName={model.roleName}
          channel={model.channelInfo}
          me={model.me}
          run={flow.run}
          published={model.published}
          planned={model.planned}
          onApply={flow.apply}
          onCancel={flow.leave}
          onClose={flow.leave}
          onRetry={flow.retry}
        />
      )}
    </div>
  );
}
