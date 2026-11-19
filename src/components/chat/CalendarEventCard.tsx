import { Calendar, CalendarDays, Check, Clock, HelpCircle, MapPin, X } from "lucide-react";

import { DisplayName } from "@/components/DisplayName";
import { UserAvatar } from "@/components/UserAvatar";
import { Dialog, ChromeDialogContent } from "@/components/ui/dialog";
import { useAuthor } from "@/hooks/useAuthor";
import { FormattedMessage, useIntl } from "@/i18n";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { dittoHashtagUrl } from "@/lib/dittoUrl";
import {
  type CalendarEvent,
  type CalendarTransport,
  formatCalendarEventWhen,
  isUpcoming,
  KIND_CALENDAR_TIME,
  type RsvpStatus,
  type RsvpTally,
} from "@/lib/calendar";
import { cn } from "@/lib/utils";

function AttendeeAvatars({ pubkeys, max = 5 }: { pubkeys: string[]; max?: number }) {
  const shown = pubkeys.slice(0, max);
  const extra = pubkeys.length - shown.length;
  return (
    <div className="flex items-center">
      <div className="flex -space-x-2">
        {shown.map((pk) => (
          <UserAvatar
            key={pk}
            pubkey={pk}
            className="size-6 ring-2 ring-background"
            fallbackClassName="text-monogram"
            frame={false}
          />
        ))}
      </div>
      {extra > 0 && <span className="ml-2 text-xs text-muted-foreground">+{extra}</span>}
    </div>
  );
}

interface RsvpControlsProps {
  tally: RsvpTally;
  canRsvp: boolean;
  isSettingRsvp: boolean;
  onSet: (status: RsvpStatus) => void;
}

/**
 * Going / Maybe / Can't-go controls plus tallies; data comes from a
 * {@link CalendarTransport} (relay query for NIP-29, sealed fold for Concord).
 */
export function RsvpControls({ tally, canRsvp, isSettingRsvp, onSet }: RsvpControlsProps) {
  const { accepted, declined, tentative, mine: myStatus } = tally;
  const intl = useIntl();

  const choose = (status: RsvpStatus) => {
    onSet(status);
  };

  return (
    <div className="space-y-3">
      {canRsvp && (
        <div className="grid grid-cols-3 gap-2">
          <RsvpButton
            active={myStatus === "accepted"}
            icon={<Check className="size-4" />}
            label={intl.formatMessage({ id: "calendarEventCard.going", defaultMessage: "Going" })}
            tone="success"
            disabled={isSettingRsvp}
            onClick={() => choose("accepted")}
          />
          <RsvpButton
            active={myStatus === "tentative"}
            icon={<HelpCircle className="size-4" />}
            label={intl.formatMessage({ id: "calendarEventCard.maybe", defaultMessage: "Maybe" })}
            tone="muted"
            disabled={isSettingRsvp}
            onClick={() => choose("tentative")}
          />
          <RsvpButton
            active={myStatus === "declined"}
            icon={<X className="size-4" />}
            label={intl.formatMessage({ id: "calendarEventCard.cantGo", defaultMessage: "Can't go" })}
            tone="destructive"
            disabled={isSettingRsvp}
            onClick={() => choose("declined")}
          />
        </div>
      )}

      <div className="space-y-2 text-sm">
        {accepted.length > 0 && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">
              <FormattedMessage id="calendarEventCard.goingCount" defaultMessage="{count} going" values={{ count: accepted.length }} />
            </span>
            <AttendeeAvatars pubkeys={accepted} />
          </div>
        )}
        {tentative.length > 0 && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">
              <FormattedMessage id="calendarEventCard.maybeCount" defaultMessage="{count} maybe" values={{ count: tentative.length }} />
            </span>
            <AttendeeAvatars pubkeys={tentative} />
          </div>
        )}
        {declined.length > 0 && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">
              <FormattedMessage id="calendarEventCard.cantGoCount" defaultMessage="{count} can't go" values={{ count: declined.length }} />
            </span>
            <AttendeeAvatars pubkeys={declined} />
          </div>
        )}
        {accepted.length === 0 && tentative.length === 0 && declined.length === 0 && (
          <p className="text-xs text-muted-foreground">
            <FormattedMessage id="calendarEventCard.noRsvps" defaultMessage="No RSVPs yet." />
          </p>
        )}
      </div>
    </div>
  );
}

function RsvpButton({
  active,
  icon,
  label,
  tone,
  disabled,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  tone: "success" | "muted" | "destructive";
  disabled?: boolean;
  onClick: () => void;
}) {
  const toneActive =
    tone === "success"
      ? "bg-success text-success-foreground hover:bg-success/90"
      : tone === "destructive"
        ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
        : "bg-primary text-primary-foreground hover:bg-primary/90";
  const toneIdle =
    tone === "success"
      ? "bg-secondary/60 text-muted-foreground hover:bg-success/15 hover:text-success"
      : tone === "destructive"
        ? "bg-secondary/60 text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
        : "bg-secondary/60 text-muted-foreground hover:bg-primary/15 hover:text-primary";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        "flex items-center justify-center gap-1.5 clip-corner-lg px-2 py-2 text-xs font-medium transition-colors disabled:opacity-60",
        active ? toneActive : toneIdle,
      )}
    >
      {icon}
      {label}
    </button>
  );
}

interface CalendarEventMessageCardProps {
  event: CalendarEvent;
  tally: RsvpTally;
  canRsvp: boolean;
  isSettingRsvp: boolean;
  onSetRsvp: (status: RsvpStatus) => void;
}

/** Inline timeline card for a calendar event (kind 31922/31923); transport-agnostic. */
export function CalendarEventMessageCard({
  event,
  tally,
  canRsvp,
  isSettingRsvp,
  onSetRsvp,
}: CalendarEventMessageCardProps) {
  const past = !isUpcoming(event);
  return (
    <div className="max-w-md clip-hairline-lg [--edge:var(--border)/0.5] [--fill:var(--secondary)/0.2] [--fill-hover:var(--secondary)/0.2] px-3 py-2.5 my-1.5 space-y-2.5">
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "flex size-11 shrink-0 items-center justify-center clip-corner-lg",
            past ? "bg-secondary text-muted-foreground" : "bg-primary/15 text-primary",
          )}
        >
          {event.kind === KIND_CALENDAR_TIME ? <Clock className="size-5" /> : <CalendarDays className="size-5" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
            {past ? (
              <FormattedMessage id="calendarEventCard.pastEvent" defaultMessage="Past event" />
            ) : (
              <FormattedMessage id="calendarEventCard.event" defaultMessage="Event" />
            )}
          </div>
          <h3 className="font-semibold leading-tight break-words">{event.title}</h3>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Calendar className="size-3.5 shrink-0" />
            <span className="break-words">{formatCalendarEventWhen(event)}</span>
          </div>
          {event.location && (
            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              <MapPin className="size-3.5 shrink-0" />
              <span className="break-words">{event.location}</span>
            </div>
          )}
        </div>
      </div>

      {event.description && (
        <p className="whitespace-pre-wrap break-words text-sm text-foreground/90 line-clamp-4">
          {event.description}
        </p>
      )}

      <RsvpControls tally={tally} canRsvp={canRsvp && !past} isSettingRsvp={isSettingRsvp} onSet={onSetRsvp} />
    </div>
  );
}

interface EventDetailDialogProps {
  calendar: CalendarTransport;
  event: CalendarEvent | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EventDetailDialog({ calendar, event, open, onOpenChange }: EventDetailDialogProps) {
  const organizer = useAuthor(event?.event.pubkey);
  const organizerName = useScopedDisplayName(event?.event.pubkey, organizer.data?.metadata);

  if (!event) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent title={event.title}>
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <div className="flex size-11 shrink-0 items-center justify-center clip-corner-lg bg-primary/15 text-primary">
              {event.kind === KIND_CALENDAR_TIME ? <Clock className="size-5" /> : <CalendarDays className="size-5" />}
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-semibold leading-tight break-words">{event.title}</h2>
              <p className="text-xs text-muted-foreground">
                <FormattedMessage
                  id="calendarEventCard.organizedBy"
                  defaultMessage="Organized by {name}"
                  values={{ name: <DisplayName pubkey={event?.event.pubkey} name={organizerName} /> }}
                />
              </p>
            </div>
          </div>

          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Calendar className="size-4 shrink-0" />
              <span>{formatCalendarEventWhen(event)}</span>
            </div>
            {event.location && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <MapPin className="size-4 shrink-0" />
                <span className="break-words">{event.location}</span>
              </div>
            )}
          </div>

          {event.description && (
            <p className="whitespace-pre-wrap break-words text-sm text-foreground/90">{event.description}</p>
          )}

          {event.hashtags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {event.hashtags.map((t) => (
                <a
                  key={t}
                  href={dittoHashtagUrl(t)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="clip-corner bg-secondary px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  #{t}
                </a>
              ))}
            </div>
          )}

          <div className="border-t border-border/60 pt-4">
            <RsvpControls
              tally={calendar.rsvpsFor(event)}
              canRsvp={calendar.canRsvp}
              isSettingRsvp={calendar.isSettingRsvp}
              onSet={(status) => calendar.setRsvp(event, status)}
            />
          </div>
        </div>
      </ChromeDialogContent>
    </Dialog>
  );
}
