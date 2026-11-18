import { Check, ChevronDown, KeyRound, Loader2, RotateCw, Shield, TriangleAlert, Users, X } from "lucide-react";
import { Children, Fragment, useMemo, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { OperationProgress } from "@/components/ui/operation-progress";
import { reviewMessages as m } from "@/concord/components/accessReview/reviewMessages";
import type { ApplyPhase, ApplyRun, ApplyStep } from "@/concord/components/accessReview/useApplyRun";
import { ChannelGlyph } from "@/concord/components/ChannelGlyph";
import { MemberAvatar, MemberName } from "@/concord/components/channelEditor/editorParts";
import { GROUP_LABEL, SHEET_HEAD_ICON, SHEET_ROW, SHEET_TILE, SHEET_TITLE } from "@/concord/components/channelEditor/editorStyles";
import { SheetPageHeader } from "@/concord/components/channelEditor/SheetPageHeader";
import { WriteProgress } from "@/concord/components/WriteProgress";
import { keyWork, type AccessMove, type AccessReview, type AccessRoad } from "@/concord/lib/accessReview";
import type { ChannelView } from "@/concord/lib/types";
import { common, FormattedMessage, useIntl } from "@/i18n";
import { cn } from "@/lib/utils";

/** What a review is about: a Channel or Category (its rows are members), or one member (its rows are Channels). */
export type ReviewSubject = { kind: "scope"; label: string } | { kind: "member"; pubkey: string };

export interface ReviewChannelInfo {
  name: string;
  isPrivate: boolean;
  view?: ChannelView;
}

export interface AccessReviewProps {
  variant: "sheet" | "dialog";
  subject: ReviewSubject;
  review: AccessReview;
  /** The Channel is changing sides, which is said once rather than per member. */
  privacy?: "private" | "public";
  /** Community permissions the member gains or loses with the Role, by label. */
  permissions?: { gained: string[]; lost: string[] };
  roleName: (roleId: string) => string | undefined;
  channel: (channelIdHex: string) => ReviewChannelInfo;
  /** Whoever is making the change: the settle moves no key of theirs. */
  me?: string;
  run: ApplyRun;
  published?: number;
  planned?: number;
  onApply: () => void;
  onCancel: () => void;
  onClose: () => void;
  onRetry?: () => void;
}

/** Rows a section shows before it is asked for more, and how many more each ask adds. */
const ROWS_SHOWN = 3;
const ROWS_STEP = 50;
/** Names a sentence spells out before it counts the rest. */
const NAMES_SHOWN = 2;

type Tone = "gain" | "loss" | "keep";

interface RowData {
  key: string;
  lead: (variant: "sheet" | "dialog") => ReactNode;
  label: ReactNode;
  road?: ReactNode;
}

interface Sentence {
  key: string;
  node: ReactNode;
}

const b = (chunks: ReactNode) => <b className="font-semibold text-foreground">{chunks}</b>;

function Road({ road, lost, roleName }: { road: AccessRoad | undefined; lost: boolean; roleName: (id: string) => string | undefined }) {
  if (!road) return null;
  if (road.kind === "role") {
    const role = roleName(road.id);
    if (!role) return null;
    return <FormattedMessage {...(lost ? m.roadRoleLost : m.roadRole)} values={{ role }} />;
  }
  if (road.kind === "member") return <FormattedMessage {...(lost ? m.roadMemberLost : m.roadMember)} />;
  if (road.kind === "creator") return <FormattedMessage {...m.roadCreator} />;
  return <FormattedMessage {...(lost ? m.roadEveryoneLost : m.roadEveryone)} />;
}

function Mark({ tone, small }: { tone: Tone; small?: boolean }) {
  const Icon = tone === "loss" ? X : Check;
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center clip-corner",
        small ? "size-5" : "size-7",
        tone === "loss" ? "bg-destructive/15 text-destructive" : tone === "gain" ? "bg-primary/15 text-primary" : "bg-secondary text-muted-foreground",
      )}
    >
      <Icon className={small ? "size-3" : "size-4"} strokeWidth={2.5} />
    </span>
  );
}

function Section({ variant, title, tone, rows }: { variant: "sheet" | "dialog"; title: ReactNode; tone?: Tone; rows: RowData[] }) {
  const [shown, setShown] = useState(ROWS_SHOWN);
  if (rows.length === 0) return null;
  // One row past the cut is shown rather than a "1 more" row standing in for it.
  const visible = rows.length <= shown + 1 ? rows : rows.slice(0, shown);
  const rest = rows.length - visible.length;
  const more = () => setShown((n) => n + ROWS_STEP);
  const count = <FormattedMessage {...m.more} values={{ count: rest }} />;
  if (variant === "sheet") {
    return (
      <section>
        <h3 className={cn(GROUP_LABEL, "px-3 pb-1 pt-2")}>{title}</h3>
        {visible.map((row) => (
          <div key={row.key} className={cn(SHEET_ROW, "text-foreground active:bg-transparent")}>
            {row.lead("sheet")}
            <span className="min-w-0 flex-1">
              <span className="block truncate">{row.label}</span>
              {row.road && <span className="block truncate text-xs font-normal text-muted-foreground">{row.road}</span>}
            </span>
            {tone && <Mark tone={tone} />}
          </div>
        ))}
        {rest > 0 && (
          <button type="button" className={cn(SHEET_ROW, "text-foreground")} onClick={more}>
            <span className={SHEET_TILE}>
              <Users className="size-5 text-muted-foreground" />
            </span>
            <span className="min-w-0 flex-1 truncate">{count}</span>
            <ChevronDown className="size-5 shrink-0 text-muted-foreground" />
          </button>
        )}
      </section>
    );
  }
  return (
    <section className="space-y-1.5">
      <h3 className={GROUP_LABEL}>{title}</h3>
      <div className="rounded-lg bg-secondary/40 py-1">
        {visible.map((row) => (
          <div key={row.key} className="flex min-h-9 items-center gap-2 px-3 py-1.5 text-sm">
            {row.lead("dialog")}
            <span className="min-w-0 flex-1 truncate font-medium">{row.label}</span>
            {row.road && <span className="max-w-[50%] shrink-0 truncate text-xs text-muted-foreground">{row.road}</span>}
            {tone && <Mark tone={tone} small />}
          </div>
        ))}
        {rest > 0 && (
          <button
            type="button"
            className="flex min-h-9 w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-muted-foreground hover:text-foreground"
            onClick={more}
          >
            <span className="min-w-0 flex-1 truncate">{count}</span>
            <ChevronDown className="size-4 shrink-0" />
          </button>
        )}
      </div>
    </section>
  );
}

const STEP_LABEL = { save: m.stepSave, private: m.stepPrivate, rotate: m.stepRotate, send: m.stepSend } as const;

function StepRow({ step, variant, count }: { step: ApplyStep; variant: "sheet" | "dialog"; count: number }) {
  const icon =
    step.state === "done" ? (
      <Check className="size-4 text-success" strokeWidth={2.5} />
    ) : step.state === "active" ? (
      <Loader2 className="size-4 animate-spin text-muted-foreground" />
    ) : step.state === "failed" ? (
      <X className="size-4 text-destructive" strokeWidth={2.5} />
    ) : (
      <span className="size-4 rounded-full border border-muted-foreground/40" />
    );
  return (
    <li className={cn("flex items-start gap-3", variant === "sheet" ? "px-3 py-1.5" : "gap-2")}>
      <span
        className={cn(
          "flex shrink-0 items-center justify-center",
          variant === "sheet" ? cn(SHEET_TILE, step.state === "failed" && "bg-destructive/15") : "mt-0.5 size-4",
        )}
      >
        {icon}
      </span>
      <span className={cn("min-w-0 flex-1", variant === "sheet" && "self-center")}>
        <span className={cn("block", variant === "sheet" && "text-chat font-medium", step.state === "pending" ? "text-muted-foreground" : "text-foreground")}>
          <FormattedMessage {...STEP_LABEL[step.phase]} values={{ count }} />
        </span>
        {step.error && <span className="block break-words text-xs text-destructive">{step.error}</span>}
      </span>
    </li>
  );
}

const unique = <T,>(items: T[]) => [...new Set(items)];

/**
 * A change to who can read what, shown before it is written and kept on screen
 * until it has finished: who gains and who loses, what it means in a sentence,
 * then each step as it runs and what still stands if one fails.
 */
export function AccessReviewPanel({
  variant,
  subject,
  review,
  privacy,
  permissions,
  roleName,
  channel,
  me,
  run,
  published = 0,
  planned = 0,
  onApply,
  onCancel,
  onClose,
  onRetry,
}: AccessReviewProps) {
  const intl = useIntl();
  const sheet = variant === "sheet";
  const { status, steps, stuck } = run;

  const list = (items: ReactNode[]): ReactNode => {
    const head = items.slice(0, items.length > NAMES_SHOWN + 1 ? NAMES_SHOWN : items.length);
    const rest = items.length - head.length;
    const all = rest > 0 ? [...head, intl.formatMessage(m.others, { count: rest })] : head;
    return <>{Children.toArray(intl.formatList(all, { type: "conjunction" }))}</>;
  };
  const names = (moves: AccessMove[]) => list(unique(moves.map((x) => x.member)).map((pk) => <MemberName key={pk} pubkey={pk} />));
  const where = (ids: string[]) => list(unique(ids).map((id) => `#${channel(id).name}`));
  const said = (moves: AccessMove[]) => ({ count: unique(moves.map((x) => x.member)).length, names: names(moves), where: where(moves.map((x) => x.channelIdHex)), b });

  const rowsOf = (moves: AccessMove[], lost: boolean): RowData[] => {
    const seen = new Set<string>();
    const out: RowData[] = [];
    for (const move of moves) {
      const key = subject.kind === "scope" ? move.member : move.channelIdHex;
      if (seen.has(key)) continue;
      seen.add(key);
      const road = <Road road={move.road} lost={lost} roleName={roleName} />;
      if (subject.kind === "scope") {
        out.push({
          key,
          lead: (v) => (v === "sheet" ? <MemberAvatar pubkey={key} className="size-10" fallbackClassName="text-sm" /> : <MemberAvatar pubkey={key} className="size-6" fallbackClassName="text-2xs" />),
          label: <MemberName pubkey={key} />,
          road,
        });
      } else {
        const info = channel(key);
        out.push({
          key,
          lead: (v) =>
            v === "sheet" ? (
              <span className={SHEET_TILE}>
                <ChannelGlyph isPrivate={info.isPrivate} view={info.view} className="size-5 text-muted-foreground" />
              </span>
            ) : (
              <ChannelGlyph isPrivate={info.isPrivate} view={info.view} className="size-4 shrink-0 text-muted-foreground" />
            ),
          label: info.name,
          road,
        });
      }
    }
    return out;
  };
  const permissionRow = (labels: string[]): RowData[] =>
    labels.length === 0
      ? []
      : [
          {
            key: "permissions",
            lead: (v) =>
              v === "sheet" ? (
                <span className={SHEET_TILE}>
                  <Shield className="size-5 text-muted-foreground" />
                </span>
              ) : (
                <Shield className="size-4 shrink-0 text-muted-foreground" />
              ),
            label: intl.formatList(labels, { type: "conjunction" }),
          },
        ];

  const losses = rowsOf(review.losses, true);
  const gains = rowsOf(review.gains, false);
  const keeps = rowsOf(review.keeps, false);
  const work = useMemo(() => keyWork(review, me), [review, me]);
  const countOf = (phase: ApplyPhase) => (phase === "rotate" ? Math.max(1, work.rotate.length) : phase === "send" ? Math.max(1, work.send.length) : 1);

  const keyedLosses = review.losses.filter((x) => x.keyed && x.member !== me);
  const hidden = review.losses.filter((x) => !x.keyed);
  const keyedGains = review.gains.filter((x) => x.keyed && !x.fresh);
  const fresh = review.gains.filter((x) => x.fresh);
  const shown = review.gains.filter((x) => !x.keyed);
  const context = subject.kind === "scope" ? subject.label : <MemberName pubkey={subject.pubkey} />;

  const summary: Sentence[] = [];
  if (privacy === "private") summary.push({ key: "private", node: <FormattedMessage {...m.goesPrivate} values={{ where: context }} /> });
  if (privacy === "public") summary.push({ key: "public", node: <FormattedMessage {...m.goesPublic} values={{ where: context }} /> });
  const keyedLost = review.losses.filter((x) => x.keyed);
  if (keyedLost.length) summary.push({ key: "loseKeyed", node: <FormattedMessage {...m.loseKeyed} values={said(keyedLost)} /> });
  if (hidden.length) summary.push({ key: "loseHidden", node: <FormattedMessage {...m.loseHidden} values={said(hidden)} /> });
  if (keyedGains.length) summary.push({ key: "gainKeyed", node: <FormattedMessage {...m.gainKeyed} values={said(keyedGains)} /> });
  if (fresh.length) summary.push({ key: "gainFresh", node: <FormattedMessage {...m.gainFresh} values={said(fresh)} /> });
  if (shown.length) summary.push({ key: "gainShown", node: <FormattedMessage {...m.gainShown} values={said(shown)} /> });
  summary.push({ key: "keepOpen", node: <FormattedMessage {...m.keepOpen} values={{ b }} /> });

  const notes: Sentence[] = [];
  if (status === "unfinished") {
    const report = run.report;
    if (run.failure === "write") notes.push({ key: "stopped", node: <FormattedMessage {...m.stopped} /> });
    else if (!report) notes.push({ key: "keys", node: <FormattedMessage {...m.keysNotMoved} /> });
    else {
      const unrotated = new Set([...report.rotationFailed.map((f) => f.channelIdHex), ...report.notRotated, ...report.unheldLost]);
      const still = keyedLosses.filter((x) => unrotated.has(x.channelIdHex));
      if (still.length) notes.push({ key: "rotate", node: <FormattedMessage {...m.stillReads} values={said(still)} /> });
      else if (unrotated.size) notes.push({ key: "keys", node: <FormattedMessage {...m.keysNotMoved} /> });
      if (report.unheldLost.length) notes.push({ key: "rotateUnheld", node: <FormattedMessage {...m.rotateUnheld} /> });
      if (report.notRotated.length) notes.push({ key: "rotateNotAllowed", node: <FormattedMessage {...m.rotateNotAllowed} /> });
      if (report.sendFailed !== undefined) notes.push({ key: "send", node: <FormattedMessage {...m.notSent} /> });
      if (report.unheldGained.length) notes.push({ key: "sendUnheld", node: <FormattedMessage {...m.sendUnheld} values={{ where: where(report.unheldGained) }} /> });
    }
    if (notes.length === 0) notes.push({ key: "keys", node: <FormattedMessage {...m.keysNotMoved} /> });
  }

  const sentences = (items: Sentence[]) =>
    items.map(({ key, node }, i) => (
      <Fragment key={key}>
        {i > 0 && " "}
        {node}
      </Fragment>
    ));

  const active = steps.find((s) => s.state === "active")?.phase;
  const title =
    status === "working" ? <FormattedMessage {...m.applyingTitle} /> : status === "unfinished" ? <FormattedMessage {...m.unfinishedTitle} /> : <FormattedMessage {...(sheet ? m.title : m.heading)} />;
  const HeadIcon = status === "unfinished" ? TriangleAlert : KeyRound;
  const headText = status === "unfinished" ? "text-destructive" : "text-primary";
  const headTone = cn(headText, status === "unfinished" ? "bg-destructive/15" : "bg-primary/15");

  const header = sheet ? (
    status === "review" ? (
      <SheetPageHeader onBack={onCancel} title={title} context={context} />
    ) : (
      <div className="flex shrink-0 items-center gap-3 px-5 pb-2 pt-1">
        <span className={cn(SHEET_HEAD_ICON, headText)}>
          <HeadIcon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className={SHEET_TITLE}>{title}</h2>
          <p className="truncate text-xs text-muted-foreground">{context}</p>
        </div>
      </div>
    )
  ) : (
    <div className="flex shrink-0 flex-col items-center gap-2 text-center">
      <div className={cn("flex size-12 items-center justify-center clip-corner-lg", headTone)}>
        <HeadIcon className="size-6" />
      </div>
      <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground">{title}</h2>
      <p className="max-w-full truncate text-sm text-muted-foreground">{context}</p>
    </div>
  );

  const card = (tone: "plain" | "warning" | "destructive", children: ReactNode) => (
    <p
      className={cn(
        "rounded-lg px-3 py-2.5 text-sm text-muted-foreground",
        sheet && "mx-3 mt-2",
        tone === "plain" ? "bg-secondary/60" : tone === "warning" ? "bg-warning/10" : "bg-destructive/10",
      )}
      {...(tone === "destructive" ? { role: "alert" } : {})}
    >
      {children}
    </p>
  );

  const body =
    status === "review" ? (
      <>
        <Section variant={variant} tone="loss" title={<FormattedMessage {...m.loses} values={{ count: losses.length }} />} rows={losses} />
        <Section variant={variant} tone="gain" title={<FormattedMessage {...m.gains} values={{ count: gains.length }} />} rows={gains} />
        <Section variant={variant} tone="keep" title={<FormattedMessage {...m.keeps} values={{ count: keeps.length }} />} rows={keeps} />
        <Section variant={variant} title={<FormattedMessage {...m.gainsPermissions} />} rows={permissionRow(permissions?.gained ?? [])} />
        <Section variant={variant} title={<FormattedMessage {...m.losesPermissions} />} rows={permissionRow(permissions?.lost ?? [])} />
        {card("plain", sentences(summary))}
      </>
    ) : (
      <>
        <ul className={cn("text-sm", !sheet && "space-y-1.5")} aria-live="polite">
          {steps.map((step) => (
            <StepRow key={step.phase} step={step} variant={variant} count={countOf(step.phase)} />
          ))}
        </ul>
        {status === "working" && (
          <div className={cn(sheet && "px-3 pt-2")}>
            {active === "rotate" || active === "send" ? (
              <OperationProgress label={intl.formatMessage(m.sealing)} />
            ) : (
              <WriteProgress published={published} planned={planned} />
            )}
          </div>
        )}
        {status === "working" &&
          card(
            "warning",
            sentences([
              { key: "keepOpen", node: <FormattedMessage {...m.keepOpenWorking} values={{ b }} /> },
              ...(keyedLosses.length ? [{ key: "ifStopped", node: <FormattedMessage {...m.ifStopped} values={said(keyedLosses)} /> }] : []),
              ...(stuck ? [{ key: "stuck", node: <FormattedMessage {...m.stuck} /> }] : []),
            ]),
          )}
        {status === "unfinished" && card("destructive", sentences(notes))}
      </>
    );

  const grow = "flex-1 clip-corner-lg";
  const footer =
    status === "review" ? (
      <>
        <Button type="button" variant="ghost" className={grow} onClick={onCancel}>
          <FormattedMessage {...common.cancel} />
        </Button>
        <Button type="button" className={grow} onClick={onApply}>
          <Check className="size-4" />
          <FormattedMessage {...m.apply} />
        </Button>
      </>
    ) : status === "working" ? (
      <>
        <Button type="button" variant="ghost" className={grow} disabled={!stuck} onClick={onClose}>
          <FormattedMessage {...(stuck ? common.close : common.cancel)} />
        </Button>
        <Button type="button" className={grow} disabled>
          <Loader2 className="size-4 animate-spin" />
          <FormattedMessage {...m.applying} />
        </Button>
      </>
    ) : (
      <>
        <Button type="button" variant={onRetry ? "ghost" : "default"} className={grow} onClick={onClose}>
          <FormattedMessage {...common.close} />
        </Button>
        {onRetry && (
          <Button type="button" className={grow} onClick={onRetry}>
            <RotateCw className="size-4" />
            <FormattedMessage {...common.tryAgain} />
          </Button>
        )}
      </>
    );

  return sheet ? (
    <>
      {header}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-1">{body}</div>
      <div className="flex shrink-0 items-center gap-2 px-5 pt-3 pb-[var(--safe-area-pad-bottom,0.75rem)]">{footer}</div>
    </>
  ) : (
    <>
      {header}
      <div className="mt-4 min-h-0 flex-1 space-y-3 overflow-y-auto">{body}</div>
      <div className="mt-6 flex shrink-0 items-center gap-2">{footer}</div>
    </>
  );
}
