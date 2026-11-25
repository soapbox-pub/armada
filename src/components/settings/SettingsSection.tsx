import { ChevronRight, Info } from "lucide-react";
import { useContext } from "react";
import { Link } from "react-router-dom";

import { SettingsPageTitleContext } from "@/components/settings/settingsNav";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useIntl } from "@/i18n";
import { cn } from "@/lib/utils";

import type { LucideIcon } from "lucide-react";
import type { ComponentType, ReactNode } from "react";

/**
 * Settings primitives, laid out like a native settings app: a page is a stack
 * of groups, each an optional uppercase heading over one cut-corner `bg-chrome`
 * card of hairline-divided rows, with optional footnote copy under it.
 */

/** Theme tokens an icon tile can be tinted with; they retint with the theme. */
export type SettingsTone = "primary" | "accent2" | "success" | "warning" | "destructive" | "muted";

const TONE_CLASS: Record<SettingsTone, string> = {
  primary: "bg-primary/15 text-primary",
  accent2: "bg-accent2/15 text-accent2",
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  destructive: "bg-destructive/15 text-destructive",
  muted: "bg-muted-foreground/15 text-muted-foreground",
};

export function SettingsIcon({ icon: Icon, tone = "muted", className }: { icon: LucideIcon | ComponentType<{ className?: string }>; tone?: SettingsTone; className?: string }) {
  return (
    <span className={cn("flex size-8 shrink-0 items-center justify-center clip-corner", TONE_CLASS[tone], className)}>
      <Icon className="size-[1.125rem]" />
    </span>
  );
}

/**
 * An ⓘ button whose popover holds the long explanation a row would otherwise
 * print. Never place one inside a pressable row: it would nest a button.
 */
export function InfoTip({ label, children, className }: { label?: string; children: ReactNode; className?: string }) {
  const intl = useIntl();
  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={label ?? intl.formatMessage({ id: "settingsSection.moreInfo", defaultMessage: "More info" })}
            className={cn(
              // The hit area grows on touch without moving the layout around it.
              "relative inline-flex size-5 shrink-0 items-center justify-center align-middle text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:text-foreground touch:after:absolute touch:after:-inset-3",
              className,
            )}
          >
            <Info className="size-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-3 text-xs font-normal normal-case leading-snug tracking-normal text-muted-foreground">
          {children}
        </PopoverContent>
      </Popover>
      {/* Settings search filters by rendered text, and the popover is portaled away. */}
      <span hidden>{children}</span>
    </>
  );
}

interface SettingsGroupProps {
  /** Anchor for deep links (`/settings#<id>`). */
  id?: string;
  title?: ReactNode;
  /** Explanatory copy under the card, as native settings put it. Keep it to a line. */
  footer?: ReactNode;
  /** Longer explanation, behind an ⓘ beside the title. Needs `title`. */
  info?: ReactNode;
  /** No card: for a section that is already its own surface (the profile editor). */
  bare?: boolean;
  children: ReactNode;
  className?: string;
}

export function SettingsGroup({ id, title, footer, info, bare, children, className }: SettingsGroupProps) {
  const intl = useIntl();
  const pageTitle = useContext(SettingsPageTitleContext);
  const searchTitle = [pageTitle, typeof title === "string" ? title : ""].filter(Boolean).join(" ");
  return (
    <section
      id={id ? `settings-${id}` : undefined}
      data-settings-section
      data-settings-title={searchTitle}
      className={cn("scroll-mt-4 space-y-1.5", className)}
    >
      {title && (
        <h3 className="flex items-center gap-1 px-4 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
          {info && <InfoTip label={typeof title === "string" ? intl.formatMessage({ id: "settingsSection.aboutGroup", defaultMessage: "About {title}" }, { title }) : undefined}>{info}</InfoTip>}
        </h3>
      )}
      <div
        data-settings-body
        className={bare ? undefined : "bg-chrome clip-corner-lg overflow-hidden [&>*]:border-chrome [&>*:not(:first-child)]:border-t"}
      >
        {children}
      </div>
      {footer && <div className="px-4 text-xs leading-snug text-muted-foreground">{footer}</div>}
    </section>
  );
}

interface SettingsRowProps {
  /** Row label (left). When omitted, `children` fills the whole row. */
  label?: ReactNode;
  /** One short line under the label. */
  description?: ReactNode;
  /** Longer explanation, behind an ⓘ beside the label. Not for pressable rows. */
  info?: ReactNode;
  /** Leading icon tile. */
  icon?: LucideIcon;
  tone?: SettingsTone;
  /** Muted text before the chevron or control: the current value. */
  value?: ReactNode;
  children?: ReactNode;
  onClick?: () => void;
  /** In-app route; the row renders as a link with a chevron. */
  to?: string;
  /** External or `mailto:` link. */
  href?: string;
  /** Draw a chevron: the row opens something. Defaults on for `to`. */
  chevron?: boolean;
  destructive?: boolean;
  /** Stack a wide control below the label until `sm:`, so it doesn't crush the label column. */
  stack?: boolean;
  className?: string;
}

const ROW_CLASS = "flex w-full gap-3 px-4 py-3 text-left min-h-[3.25rem] touch:min-h-14";
const PRESSABLE_CLASS = "transition-colors hover:bg-accent/40 active:bg-accent/60 focus-visible:outline-none focus-visible:bg-accent/40";

/** One flat settings row: labelled (label left, control right) or bare (`children` full-width). */
export function SettingsRow({
  label,
  description,
  info,
  icon,
  tone,
  value,
  children,
  onClick,
  to,
  href,
  chevron,
  destructive,
  stack,
  className,
}: SettingsRowProps) {
  const intl = useIntl();
  if (label === undefined) {
    return <div className={cn("px-4 py-3.5", className)}>{children}</div>;
  }
  const pressable = !!(onClick || to || href);
  const showChevron = chevron ?? !!to;
  const rowClass = cn(
    ROW_CLASS,
    stack ? "flex-col sm:flex-row sm:items-center" : "items-center",
    pressable && PRESSABLE_CLASS,
    className,
  );
  const body = (
    <>
      {icon && (stack ? (
        <span className="hidden sm:contents"><SettingsIcon icon={icon} tone={tone} /></span>
      ) : <SettingsIcon icon={icon} tone={tone} />)}
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className={cn("text-sm font-medium leading-tight", destructive && "text-destructive")}>
          {label}
          {info && !pressable && (
            <InfoTip label={typeof label === "string" ? intl.formatMessage({ id: "settingsSection.aboutRow", defaultMessage: "About {label}" }, { label }) : undefined} className="-my-1 ml-1">{info}</InfoTip>
          )}
        </div>
        {description && (
          <div className="text-xs text-muted-foreground leading-snug">{description}</div>
        )}
      </div>
      {value !== undefined && (
        <div className="min-w-0 max-w-[45%] shrink-0 truncate text-right text-sm text-muted-foreground">{value}</div>
      )}
      {children !== undefined && (
        <div className={cn(stack ? "w-full sm:w-auto sm:shrink-0" : "shrink-0")}>{children}</div>
      )}
      {showChevron && <ChevronRight className="size-4 shrink-0 text-muted-foreground/70" aria-hidden />}
    </>
  );
  if (to) return <Link to={to} className={rowClass}>{body}</Link>;
  if (href) {
    const external = /^https?:/i.test(href);
    return (
      <a href={href} className={rowClass} {...(external && { target: "_blank", rel: "noreferrer" })}>
        {body}
      </a>
    );
  }
  if (onClick) return <button type="button" onClick={onClick} className={rowClass}>{body}</button>;
  return <div className={rowClass}>{body}</div>;
}
