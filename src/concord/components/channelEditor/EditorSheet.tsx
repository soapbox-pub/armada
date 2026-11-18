import { Check, ChevronRight, Folder, FolderX, KeyRound, Loader2, Lock, Plus, RefreshCw, RotateCw, SlidersHorizontal, Trash2 } from "lucide-react";
import { useId, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { PillTabs, type PillTab } from "@/components/ui/pill-tabs";
import { Switch } from "@/components/ui/switch";
import { AccessReviewPanel } from "@/concord/components/accessReview/AccessReviewPanel";
import { ChannelGlyph } from "@/concord/components/ChannelGlyph";
import { EditorLegacyAccess } from "@/concord/components/channelEditor/EditorLegacyAccess";
import { ConfirmText, GeneralFields, RuleGroups, TargetLabel, TargetLead, TargetPicker, TargetSummary } from "@/concord/components/channelEditor/editorParts";
import { editorMessages as m } from "@/concord/components/channelEditor/editorMessages";
import { GROUP_LABEL, SHEET_DIVIDER, SHEET_HEAD_ICON, SHEET_ROW, SHEET_TILE, SHEET_TITLE } from "@/concord/components/channelEditor/editorStyles";
import { SheetPageHeader as PageHeader } from "@/concord/components/channelEditor/SheetPageHeader";
import type { EditorModel, EditorTab } from "@/concord/components/channelEditor/useChannelEditor";
import { useEditorFlow } from "@/concord/components/channelEditor/useEditorFlow";
import { WriteProgress } from "@/concord/components/WriteProgress";
import { useOverlayBack } from "@/hooks/useAndroidBack";
import { common, FormattedMessage, useIntl } from "@/i18n";
import { cn } from "@/lib/utils";

/** Window after opening in which an outside-dismiss is refused: the opening press leaves a trailing event read as an outside tap. */
const OPEN_GUARD_MS = 400;

type Page = { id: "root" } | { id: "category" } | { id: "rule"; key: string } | { id: "picker" };

const LIST = "min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-1";
const FOOTER = "flex shrink-0 items-center gap-2 px-5 pt-2 pb-[var(--safe-area-pad-bottom,0.75rem)]";

function Row({
  icon: Icon,
  lead,
  label,
  hint,
  value,
  chevron,
  chosen,
  destructive,
  ...props
}: {
  icon?: ComponentType<{ className?: string }>;
  lead?: ReactNode;
  label: ReactNode;
  hint?: ReactNode;
  value?: ReactNode;
  chevron?: boolean;
  chosen?: boolean;
  destructive?: boolean;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button type="button" className={cn(SHEET_ROW, destructive ? "text-destructive" : "text-foreground")} {...props}>
      {lead ??
        (Icon && (
          <span className={cn(SHEET_TILE, chosen && "bg-primary/20")}>
            <Icon className={cn("size-5", chosen ? "text-primary" : !destructive && "text-muted-foreground")} />
          </span>
        ))}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {hint && <span className="block truncate text-xs font-normal text-muted-foreground">{hint}</span>}
      </span>
      {value != null && <span className="max-w-[45%] shrink-0 truncate text-sm font-normal text-muted-foreground">{value}</span>}
      {chevron && <ChevronRight className="size-5 shrink-0 text-muted-foreground" />}
      {chosen && <Check className="size-5 shrink-0 text-primary" />}
    </button>
  );
}

function SwitchRow({
  icon: Icon,
  title,
  hint,
  checked,
  onCheckedChange,
  disabled,
}: {
  icon: ComponentType<{ className?: string }>;
  title: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className={cn(SHEET_ROW, "cursor-pointer text-foreground", disabled && "opacity-50")}>
      <span className={SHEET_TILE}>
        <Icon className="size-5 text-muted-foreground" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{title}</span>
        {hint && <span className="block text-xs font-normal text-muted-foreground">{hint}</span>}
      </span>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
    </label>
  );
}

const Heading = ({ children }: { children: ReactNode }) => <div className={cn(GROUP_LABEL, "px-3 pb-1 pt-2")}>{children}</div>;
const Divider = () => <div role="separator" className={SHEET_DIVIDER} />;

/**
 * The Channel and Category editor as a bottom sheet, in the touch menu sheet's
 * format: rows that open pages of the same sheet, and a footer that saves.
 */
export function EditorSheet({ model, open, onOpenChange }: { model: EditorModel; open: boolean; onOpenChange: (open: boolean) => void }) {
  const intl = useIntl();
  const { scope, values } = model;
  const isChannel = scope.kind === "channel";
  const [tab, setTab] = useState<EditorTab>(scope.tab ?? "general");
  const [page, setPage] = useState<Page>({ id: "root" });
  const flow = useEditorFlow(model, () => onOpenChange(false));
  const root = () => setPage({ id: "root" });

  // Stamped during the opening render, NOT in an effect: an effect runs after the layer is listening.
  const openedAt = useRef(0);
  const [wasOpen, setWasOpen] = useState(false);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) openedAt.current = Date.now();
  }
  const guard = (e: { preventDefault: () => void }) => {
    if (flow.locked || Date.now() - openedAt.current < OPEN_GUARD_MS) e.preventDefault();
  };

  useOverlayBack(() => {
    if (flow.review) {
      if (!flow.locked) flow.leave();
    } else if (flow.confirm) flow.dismiss();
    else if (page.id !== "root") root();
    else onOpenChange(false);
    return true;
  }, open);

  const tabs = useMemo<PillTab<EditorTab>[]>(
    () => [
      { id: "general", label: intl.formatMessage(m.general), icon: SlidersHorizontal },
      { id: "permissions", label: intl.formatMessage(m.permissions), icon: KeyRound },
    ],
    [intl],
  );

  const ruled = page.id === "rule" ? model.targets.find((t) => t.key === page.key) : undefined;
  const nested = flow.review !== null || (page.id !== "root" && (page.id !== "rule" || ruled !== undefined));
  const noCategory = <FormattedMessage {...m.noCategory} />;

  const targetRows = (
    <>
      <Heading>
        <FormattedMessage {...m.targets} />
      </Heading>
      {model.unkeyed && model.canManageRoles && (
        <p className="px-3 pb-2 text-xs text-muted-foreground">
          <FormattedMessage {...m.unkeyed} />
        </p>
      )}
      {model.targets.map((target) => (
        <Row
          key={target.key}
          lead={<TargetLead target={target} variant="sheet" />}
          label={<TargetLabel target={target} />}
          value={<TargetSummary view={target.view} others={target.others} />}
          chevron
          onClick={() => setPage({ id: "rule", key: target.key })}
        />
      ))}
      {model.canManageRoles && (
        <Row
          icon={Plus}
          label={<FormattedMessage {...m.addTarget} />}
          disabled={model.busy || model.unkeyed}
          onClick={() => setPage({ id: "picker" })}
        />
      )}
    </>
  );

  const rotateRow = model.rotateKey && (
    <>
      <Divider />
      <Row
        icon={RotateCw}
        label={<FormattedMessage {...m.rotate} />}
        hint={<FormattedMessage {...m.rotateHint} />}
        disabled={model.busy || model.dirty}
        onClick={() => flow.ask("rotate")}
      />
    </>
  );

  const privateSwitch = (
    <SwitchRow
      icon={Lock}
      title={<FormattedMessage {...m.private} />}
      hint={<FormattedMessage {...m.privateHint} />}
      checked={values.isPrivate}
      onCheckedChange={model.setPrivate}
      disabled={!model.canManageChannels || model.busy || (!model.ranked && !model.base.isPrivate)}
    />
  );

  const general = (
    <>
      <div className="space-y-4 px-3 pb-3 pt-1">
        <GeneralFields model={model} surface="background" />
      </div>
      {isChannel && (model.categories.length > 0 || values.category !== undefined) && (
        <Row
          icon={Folder}
          label={<FormattedMessage {...m.category} />}
          value={model.categoryName ?? noCategory}
          chevron
          disabled={!model.canManageChannels || model.busy}
          onClick={() => setPage({ id: "category" })}
        />
      )}
    </>
  );

  const permissions = model.ranked ? (
    <>
      {values.category !== undefined && (
        <SwitchRow
          icon={Folder}
          title={
            <FormattedMessage {...m.sync} values={{ category: model.categoryName ?? "" }} />
          }
          hint={<FormattedMessage {...(model.canManageRoles && !model.canSync ? m.syncRefused : m.syncHint)} />}
          checked={values.synced}
          onCheckedChange={model.setSynced}
          disabled={!model.canManageRoles || model.busy || !model.canSync}
        />
      )}
      {privateSwitch}
      <Divider />
      {values.synced ? (
        <p className="px-3 py-2 text-sm text-muted-foreground">
          <FormattedMessage
            {...m.syncedNote}
            values={{ category: model.categoryName ?? "" }}
          />
        </p>
      ) : (
        targetRows
      )}
      {rotateRow}
    </>
  ) : (
    <>
      {privateSwitch}
      <Divider />
      <div className="px-3 py-2">
        <EditorLegacyAccess model={model} />
      </div>
      {rotateRow}
    </>
  );

  const category = (
    <>
      <div className="space-y-4 px-3 pb-3 pt-1">
        <GeneralFields model={model} surface="background" />
      </div>
      {model.ranked && model.canManageRoles && (
        <>
          <Divider />
          {targetRows}
          {model.unsyncedCount > 0 && (
            <>
              <Divider />
              <Row
                icon={RefreshCw}
                label={<FormattedMessage {...m.syncAll} />}
                hint={<FormattedMessage {...m.syncAllHint} values={{ count: model.unsyncedCount }} />}
                disabled={model.busy || !model.canSyncAll}
                onClick={() => void model.syncAll()}
              />
              {!model.canSyncAll && (
                <p className="px-3 pb-2 text-xs text-muted-foreground">
                  <FormattedMessage {...m.syncRefused} />
                </p>
              )}
            </>
          )}
        </>
      )}
    </>
  );

  return (
    // A change being applied holds the sheet open until it has finished.
    <Drawer open={open} dismissible={!flow.locked} onOpenChange={(next) => (next || !flow.locked) && onOpenChange(next)}>
      <DrawerContent
        // The popup's layer, like the menu sheet this is opened from.
        className="z-[260] max-h-[85dvh]"
        overlayClassName="z-[260]"
        aria-describedby={undefined}
        onPointerDownOutside={guard}
        onInteractOutside={guard}
        onEscapeKeyDown={(e) => flow.locked && e.preventDefault()}
      >
        <div className={cn("flex shrink-0 items-center gap-3 px-5 pb-2 pt-1", nested && "hidden")}>
          <span className={SHEET_HEAD_ICON}>
            {isChannel ? (
              <ChannelGlyph isPrivate={model.base.isPrivate} view={model.base.view} className="size-5 text-muted-foreground" />
            ) : (
              <Folder className="size-5 text-muted-foreground" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <DrawerTitle className={SHEET_TITLE}>{model.base.name}</DrawerTitle>
            <p className="truncate text-xs text-muted-foreground">
              {isChannel ? (
                <FormattedMessage
                  {...m.channelSub}
                  values={{
                    kind: `${model.base.isPrivate ? "private" : "public"}${model.categoryName ? "In" : ""}`,
                    category: model.categoryName ?? "",
                  }}
                />
              ) : (
                <FormattedMessage
                  {...m.categorySub}
                  values={{ count: model.channelCount }}
                />
              )}
            </p>
          </div>
        </div>

        {!nested && (
          <>
            {isChannel && (
              <div className="shrink-0 px-5 pb-3">
                <PillTabs tabs={tabs} value={tab} onChange={(id) => setTab(id)} fill />
              </div>
            )}
            <div className={LIST}>{!isChannel ? category : tab === "general" ? general : permissions}</div>
            {(flow.confirm || model.error || model.saving) && (
              <div className="shrink-0 space-y-2 px-5 pb-1 pt-2">
                {flow.confirm && (
                  <p className="text-sm text-muted-foreground">
                    <ConfirmText model={model} kind={flow.confirm} />
                  </p>
                )}
                {model.saving && <WriteProgress published={model.published} planned={model.planned} />}
                {model.error && (
                  <p role="alert" className="text-sm text-destructive">
                    {model.error}
                  </p>
                )}
              </div>
            )}
            <div className={FOOTER}>
              {flow.confirm ? (
                <>
                  <Button type="button" variant="ghost" className="flex-1 clip-corner-lg" onClick={flow.dismiss}>
                    <FormattedMessage {...common.back} />
                  </Button>
                  <Button
                    type="button"
                    variant={flow.confirm === "delete" ? "destructive" : "default"}
                    className="flex-1 clip-corner-lg"
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
                      size="icon"
                      className="shrink-0 clip-corner-lg text-destructive hover:text-destructive"
                      aria-label={
                        isChannel
                          ? intl.formatMessage(m.deleteChannel)
                          : intl.formatMessage(m.deleteCategory)
                      }
                      disabled={model.busy}
                      onClick={() => flow.ask("delete")}
                    >
                      {isChannel ? <Trash2 className="size-4" /> : <FolderX className="size-4" />}
                    </Button>
                  )}
                  <Button type="button" variant="ghost" className="flex-1 clip-corner-lg" onClick={() => onOpenChange(false)}>
                    <FormattedMessage {...common.cancel} />
                  </Button>
                  <Button type="button" className="flex-1 clip-corner-lg" disabled={!model.dirty || model.invalid || model.busy} onClick={flow.requestSave}>
                    {model.saving && <Loader2 className="size-4 animate-spin" />}
                    <FormattedMessage {...common.save} />
                  </Button>
                </>
              )}
            </div>
          </>
        )}

        {flow.review && (
          <AccessReviewPanel
            variant="sheet"
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

        {page.id === "category" && (
          <>
            <PageHeader onBack={root} title={<FormattedMessage {...m.category} />} />
            <div className={cn(LIST, "pb-[var(--safe-area-pad-bottom,0.75rem)]")} role="radiogroup">
              <Row
                icon={FolderX}
                label={noCategory}
                chosen={values.category === undefined}
                onClick={() => {
                  model.setCategory(undefined);
                  root();
                }}
              />
              {model.categories.map((c) => (
                <Row
                  key={c.key}
                  icon={Folder}
                  label={c.name}
                  chosen={values.category === c.key}
                  onClick={() => {
                    model.setCategory(c.key);
                    root();
                  }}
                />
              ))}
            </div>
          </>
        )}

        {ruled && (
          <>
            <PageHeader
              onBack={root}
              title={<TargetLabel target={ruled} />}
              context={
                <FormattedMessage
                  {...m.ruleContext}
                  values={{ scope: scope.kind, name: model.base.name }}
                />
              }
            />
            <div className={LIST}>
              <RuleGroups model={model} target={ruled} variant="sheet" />
            </div>
            <div className={FOOTER}>
              {ruled.kind !== "everyone" && model.canManageRoles && (
                <Button
                  type="button"
                  variant="ghost"
                  className="flex-1 clip-corner-lg text-destructive hover:text-destructive"
                  disabled={ruled.reach === 0n}
                  onClick={() => {
                    model.removeTarget(ruled.key);
                    root();
                  }}
                >
                  <FormattedMessage
                    {...m.removeTarget}
                    values={{ scope: scope.kind }}
                  />
                </Button>
              )}
              <Button type="button" className="flex-1 clip-corner-lg" onClick={root}>
                <FormattedMessage {...common.done} />
              </Button>
            </div>
          </>
        )}

        {page.id === "picker" && (
          <>
            <PageHeader onBack={root} title={<FormattedMessage {...m.addTarget} />} />
            <TargetPicker model={model} variant="sheet" onDone={() => root()} />
          </>
        )}
      </DrawerContent>
    </Drawer>
  );
}
