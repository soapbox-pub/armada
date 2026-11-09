import { useRoomContext } from "@livekit/components-react";
import { useQueryClient } from "@tanstack/react-query";
import { Ban, Circle, Disc, FolderOpen, Loader2, Square } from "lucide-react";
import { RoomEvent, Track, type Participant } from "livekit-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DisplayName } from "@/components/DisplayName";
import { Button } from "@/components/ui/button";
import { ChromeDialogContent, Dialog, DialogDescription } from "@/components/ui/dialog";
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ToastAction } from "@/components/ui/toast";
import {
  CallRecorderContext,
  useCallRecorder,
  type CallRecorderStatus,
  type CallRecorderValue,
} from "@/contexts/CallRecorderContext";
import { callSpeaks, subscribeCallGate } from "@/concord/lib/callGate";
import { useCallSignals } from "@/contexts/CallSignalsContext";
import { useVoiceIdentity } from "@/contexts/VoiceIdentityContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useElapsed } from "@/hooks/useElapsed";
import { toast } from "@/hooks/useToast";
import { defineMessages, FormattedMessage, t, useIntl } from "@/i18n";
import { authorQueryKey, type AuthorResult } from "@/lib/authorCache";
import { CallRecording, isCallRecordingSupported, RecordingError, type RecordingMode } from "@/lib/callRecording/engine";
import { canChooseFolder, chooseFolder, type RecordingDestination } from "@/lib/callRecording/folder";
import { canRecordOpus, RECORDING_FORMATS, type RecordingFormat } from "@/lib/callRecording/formats";
import { recordableSources } from "@/lib/callRecording/policy";
import { getRecorderOptions, setNoRecord, setRecorderOptions, type RecorderOptions } from "@/lib/callRecording/prefs";
import { TEMPLATE_VARIABLES } from "@/lib/callRecording/template";
import { getDisplayName } from "@/lib/getDisplayName";
import { cn } from "@/lib/utils";

/**
 * Mumble-style call recording for Concord calls: one file per voice (or a
 * mixdown), announced on the encrypted presence before capture starts, and
 * never including anyone who refuses or can't be verified. The take is staged
 * in OPFS and copied out on stop (`src/lib/callRecording/`).
 */

type Status = CallRecorderStatus;

const NONE: ReadonlySet<string> = new Set();

const msg = defineMessages({
  startFailed: { id: "callRecorder.startFailed", defaultMessage: "Couldn't start recording" },
  stopped: { id: "callRecorder.stoppedTitle", defaultMessage: "Recording stopped" },
  dontRecordMe: { id: "callRecorder.dontRecordMe", defaultMessage: "Don't record me" },
});

/** A display name read from the profile cache at call time (a file title, a toast). */
function useCachedName(): (pubkey: string) => string {
  const queryClient = useQueryClient();
  return useCallback(
    (pubkey: string) =>
      getDisplayName(queryClient.getQueryData<AuthorResult>(authorQueryKey(pubkey))?.metadata, pubkey),
    [queryClient],
  );
}

function micTrackOf(participant: Participant): MediaStreamTrack | undefined {
  return participant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack;
}

interface ActiveTake {
  recording: CallRecording;
  options: RecorderOptions;
  destination: RecordingDestination;
  startedAt: Date;
  names: { host: string; channel: string };
}

/** Owns the take for the life of the call. Must render inside a `LiveKitRoom`. */
export function CallRecorderProvider({ children }: { children: React.ReactNode }) {
  const room = useRoomContext();
  const resolveIdentity = useVoiceIdentity();
  const signals = useCallSignals().recording;
  const titleOf = useCachedName();
  const [status, setStatus] = useState<Status>("idle");
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [capturing, setCapturing] = useState<ReadonlySet<string>>(NONE);
  const [dialogOpen, setDialogOpen] = useState(false);
  const take = useRef<ActiveTake | null>(null);

  // Read at sync time, so a refusal reaches the take without re-arming anything.
  const live = useRef({ signals, resolveIdentity });
  live.current = { signals, resolveIdentity };

  const available = Boolean(signals) && isCallRecordingSupported();

  const sync = useCallback(() => {
    const active = take.current;
    if (!active) return;
    const { signals: current, resolveIdentity: resolve } = live.current;
    const participants = [room.localParticipant, ...room.remoteParticipants.values()].map((p) => ({
      identity: p.identity,
      isLocal: p.isLocal,
      micTrack: micTrackOf(p),
    }));
    // Without signals there is no way to honor a refusal, so nobody is recorded.
    const sources = current ? recordableSources(participants, resolve, current.refusing, titleOf, callSpeaks) : [];
    active.recording.setSources(sources);
    const now = active.recording.capturing();
    setCapturing((prev) => (prev.size === now.size && [...now].every((k) => prev.has(k)) ? prev : now));
  }, [room, titleOf]);

  const finish = useCallback(
    async (active: ActiveTake, announce: boolean) => {
      try {
        const files = await active.recording.stop();
        if (announce) void live.current.signals?.announce(false);
        // Loaded on demand: it reaches the native save plugins.
        const { exportRecording } = await import("@/lib/callRecording/export");
        const result = await exportRecording({
          id: active.recording.id,
          format: active.options.format,
          files,
          template: active.options.template,
          vars: { ...active.names, date: active.startedAt },
          perUser: active.options.mode === "multichannel",
          destination: active.destination,
        });
        toast({
          title: t({ id: "callRecorder.savedTitle", defaultMessage: "Recording saved" }),
          description: t(
            {
              id: "callRecorder.savedDescription",
              defaultMessage: "{count, plural, one {# file} other {# files}}: {names}",
            },
            { count: result.files.length, names: result.files.map((f) => f.name).join(", ") },
          ),
        });
      } catch (err) {
        if (announce) void live.current.signals?.announce(false);
        console.error("call recording: could not save", err);
        toast({
          title: t({ id: "callRecorder.saveFailedTitle", defaultMessage: "Couldn't save the recording" }),
          description: err instanceof Error ? err.message : undefined,
          variant: "destructive",
        });
      }
    },
    [],
  );

  const stop = useCallback(() => {
    const active = take.current;
    if (!active) return;
    take.current = null;
    setStatus("saving");
    setCapturing(NONE);
    void finish(active, true).finally(() => {
      setStatus("idle");
      setStartedAt(null);
    });
  }, [finish]);

  const start = useCallback(
    async (options: RecorderOptions, destination: RecordingDestination) => {
      const current = live.current.signals;
      if (!current || take.current) return;
      setStatus("starting");
      let recording: CallRecording | null = null;
      try {
        // First, inside the click: the AudioContext needs the gesture.
        recording = await CallRecording.prepare(options.mode, options.format);
        // Everyone is told before a single sample is captured.
        if (!(await current.announce(true))) {
          throw new RecordingError(
            t({
              id: "callRecorder.announceFailed",
              defaultMessage: "Couldn't tell the others in the call that you're recording, so nothing was recorded.",
            }),
          );
        }
      } catch (err) {
        recording?.abort();
        setStatus("idle");
        toast({
          title: t(msg.startFailed),
          description: err instanceof Error ? err.message : undefined,
          variant: "destructive",
        });
        return;
      }
      const active: ActiveTake = {
        recording,
        options,
        destination,
        startedAt: new Date(),
        names: current.names,
      };
      take.current = active;
      recording.begin((err) => {
        if (take.current !== active) return;
        take.current = null;
        recording.abort();
        void live.current.signals?.announce(false);
        setStatus("idle");
        setStartedAt(null);
        setCapturing(NONE);
        toast({
          title: t(msg.stopped),
          description: err.quota
            ? t({ id: "callRecorder.quota", defaultMessage: "This device ran out of storage space." })
            : err.message,
          variant: "destructive",
        });
      });
      setStartedAt(Date.now());
      setStatus("recording");
      sync();
    },
    [sync],
  );

  // Follow the room and the refusals while a take runs.
  useEffect(() => {
    if (status !== "recording") return;
    sync();
    const events = [
      RoomEvent.TrackSubscribed,
      RoomEvent.TrackUnsubscribed,
      RoomEvent.LocalTrackPublished,
      RoomEvent.LocalTrackUnpublished,
      RoomEvent.ParticipantConnected,
      RoomEvent.ParticipantDisconnected,
      RoomEvent.Reconnected,
    ] as const;
    for (const event of events) room.on(event, sync);
    // Catches what raises no room event (a noise processor swapping the mic track).
    const timer = setInterval(sync, 2_000);
    return () => {
      for (const event of events) room.off(event, sync);
      clearInterval(timer);
    };
  }, [status, room, sync]);

  // A refusal, a newly verified member or a server-mute takes effect at once.
  useEffect(() => {
    if (status === "recording") sync();
  }, [status, signals?.refusing, resolveIdentity, sync]);
  useEffect(() => (status === "recording" ? subscribeCallGate(sync) : undefined), [status, sync]);

  // Leaving the call ends the take; its files are still saved.
  useEffect(
    () => () => {
      const active = take.current;
      take.current = null;
      if (active) void finish(active, false);
    },
    [finish],
  );

  const value = useMemo<CallRecorderValue>(
    () => ({
      available,
      status,
      startedAt,
      capturing,
      openDialog: () => setDialogOpen(true),
      stop,
    }),
    [available, status, startedAt, capturing, stop],
  );

  return (
    <CallRecorderContext.Provider value={value}>
      {children}
      {available && (
        <RecordCallDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          status={status}
          startedAt={startedAt}
          capturing={capturing}
          onStart={start}
          onStop={stop}
        />
      )}
    </CallRecorderContext.Provider>
  );
}

function RecordCallDialog({
  open,
  onOpenChange,
  status,
  startedAt,
  capturing,
  onStart,
  onStop,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: Status;
  startedAt: number | null;
  capturing: ReadonlySet<string>;
  onStart: (options: RecorderOptions, destination: RecordingDestination) => Promise<void>;
  onStop: () => void;
}) {
  const intl = useIntl();
  const signals = useCallSignals().recording;
  const [options, setOptions] = useState<RecorderOptions>(() => getRecorderOptions());
  const [folder, setFolder] = useState<FileSystemDirectoryHandle | null>(null);
  const [opus, setOpus] = useState(false);
  const elapsed = useElapsed(startedAt);
  const folderSupported = canChooseFolder();
  const busy = status !== "idle";

  useEffect(() => {
    let cancelled = false;
    void canRecordOpus().then((ok) => !cancelled && setOpus(ok));
    return () => {
      cancelled = true;
    };
  }, []);

  const update = (patch: Partial<RecorderOptions>) =>
    setOptions((current) => {
      const next = { ...current, ...patch };
      setRecorderOptions(next);
      return next;
    });

  const format = options.format === "opus" && !opus ? "flac" : options.format;
  const formatLabels: Record<RecordingFormat, string> = {
    flac: intl.formatMessage({ id: "callRecorder.format.flac", defaultMessage: "FLAC: lossless, compressed" }),
    wav: intl.formatMessage({ id: "callRecorder.format.wav", defaultMessage: "WAV: uncompressed, 24-bit" }),
    opus: intl.formatMessage({ id: "callRecorder.format.opus", defaultMessage: "Opus: small, lossy" }),
    au: intl.formatMessage({ id: "callRecorder.format.au", defaultMessage: "AU: uncompressed, 32-bit float" }),
  };
  const modeLabels: Record<RecordingMode, string> = {
    multichannel: intl.formatMessage({
      id: "callRecorder.mode.multichannel",
      defaultMessage: "One file per person",
    }),
    mixdown: intl.formatMessage({ id: "callRecorder.mode.mixdown", defaultMessage: "One mixed file" }),
  };

  const refusingOthers = [...(signals?.refusing ?? [])];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent
        title={intl.formatMessage({ id: "callRecorder.title", defaultMessage: "Record call" })}
        className="sm:max-w-lg"
      >
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex size-12 items-center justify-center clip-corner-lg bg-destructive/15 text-destructive">
            <Disc className="size-6" />
          </div>
          <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground">
            <FormattedMessage id="callRecorder.heading" defaultMessage="record call" />
          </h2>
          <DialogDescription className="text-sm text-muted-foreground">
            <FormattedMessage
              id="callRecorder.description"
              defaultMessage="Everyone in the call sees that you're recording. Anyone who blocks recording, or whom the call can't verify, is left out of it."
            />
          </DialogDescription>
        </div>

        <div className="mt-6 space-y-5">
          <div className="flex items-center justify-center gap-3">
            <span
              className={cn(
                "font-mono text-2xl tabular-nums",
                status === "recording" ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {elapsed}
            </span>
            {status === "recording" && (
              <span className="text-xs text-muted-foreground">
                <FormattedMessage
                  id="callRecorder.capturingCount"
                  defaultMessage="{count, plural, one {# voice} other {# voices}}"
                  values={{ count: capturing.size }}
                />
              </span>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="call-recording-mode">
                <FormattedMessage id="callRecorder.label.mode" defaultMessage="Mode" />
              </Label>
              <Select
                value={options.mode}
                disabled={busy}
                onValueChange={(mode: RecordingMode) => update({ mode })}
              >
                <SelectTrigger id="call-recording-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["multichannel", "mixdown"] as const).map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {modeLabels[mode]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="call-recording-format">
                <FormattedMessage id="callRecorder.label.format" defaultMessage="Format" />
              </Label>
              <Select
                value={format}
                disabled={busy}
                onValueChange={(next: RecordingFormat) => update({ format: next })}
              >
                <SelectTrigger id="call-recording-format">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RECORDING_FORMATS.map((id) => (
                    <SelectItem key={id} value={id} disabled={id === "opus" && !opus}>
                      {formatLabels[id]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="call-recording-template">
              <FormattedMessage id="callRecorder.label.template" defaultMessage="File names" />
            </Label>
            <Input
              id="call-recording-template"
              value={options.template}
              disabled={busy}
              spellCheck={false}
              onChange={(event) => update({ template: event.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              <FormattedMessage
                id="callRecorder.templateHelp"
                defaultMessage="{variables} are filled in for each file; / makes folders."
                values={{ variables: TEMPLATE_VARIABLES.join(" ") }}
              />
            </p>
          </div>

          <div className="space-y-2">
            <Label>
              <FormattedMessage id="callRecorder.label.saveTo" defaultMessage="Save to" />
            </Label>
            {folderSupported ? (
              <div className="flex items-center gap-2">
                <span className="flex-1 min-w-0 truncate text-sm text-muted-foreground">
                  {folder ? (
                    folder.name
                  ) : (
                    <FormattedMessage id="callRecorder.downloads" defaultMessage="Your downloads" />
                  )}
                </span>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    void chooseFolder()
                      .then((handle) => handle && setFolder(handle))
                      .catch((err) => console.warn("call recording: folder picker failed", err));
                  }}
                >
                  <FolderOpen className="size-4" />
                  <FormattedMessage id="callRecorder.chooseFolder" defaultMessage="Choose folder" />
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                <FormattedMessage
                  id="callRecorder.savedOnStop"
                  defaultMessage="The files are saved to this device when you stop."
                />
              </p>
            )}
          </div>

          {refusingOthers.length > 0 && (
            <div className="space-y-1 text-sm">
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Ban className="size-3.5" />
                <FormattedMessage id="callRecorder.notRecorded" defaultMessage="Won't be recorded:" />
              </div>
              <ul className="pl-5 text-muted-foreground">
                {refusingOthers.map((pubkey) => (
                  <li key={pubkey} className="truncate">
                    <DisplayName pubkey={pubkey} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="mt-6 flex items-center gap-2 [&>*]:flex-1 [&>*]:clip-corner-lg">
          {status === "recording" || status === "saving" ? (
            <Button type="button" variant="secondary" disabled={status === "saving"} onClick={onStop}>
              {status === "saving" ? <Loader2 className="size-4 animate-spin" /> : <Square className="size-4" />}
              <FormattedMessage id="callRecorder.stop" defaultMessage="Stop recording" />
            </Button>
          ) : (
            <Button
              type="button"
              variant="destructive"
              disabled={status === "starting"}
              onClick={() => {
                void onStart(
                  { ...options, format },
                  folder ? { kind: "folder", handle: folder } : { kind: "download" },
                );
              }}
            >
              {status === "starting" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Circle className="size-4 fill-current" />
              )}
              <FormattedMessage id="callRecorder.start" defaultMessage="Start recording" />
            </Button>
          )}
        </div>
      </ChromeDialogContent>
    </Dialog>
  );
}

/** The recording section of the call's audio menu. Renders nothing outside a Concord call. */
export function RecordingMenuItems() {
  const recorder = useCallRecorder();
  const signals = useCallSignals().recording;
  const elapsed = useElapsed(recorder.status === "recording" ? recorder.startedAt : null);
  if (!signals) return null;
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="text-xs">
        <FormattedMessage id="callRecorder.recording" defaultMessage="Recording" />
      </DropdownMenuLabel>
      {recorder.available && (
        <DropdownMenuItem onSelect={recorder.openDialog}>
          {recorder.status === "recording" ? (
            <>
              <Square className="size-4 text-destructive" />
              <span className="flex-1">
                <FormattedMessage id="callRecorder.menu.recording" defaultMessage="Recording…" />
              </span>
              <span className="text-xs tabular-nums text-muted-foreground">{elapsed}</span>
            </>
          ) : (
            <>
              <Disc className="size-4" />
              <FormattedMessage id="callRecorder.menu.record" defaultMessage="Record call…" />
            </>
          )}
        </DropdownMenuItem>
      )}
      <label
        className="flex items-center justify-between gap-3 px-2 py-1.5 touch:py-3 text-sm cursor-pointer"
        onPointerDown={(e) => e.preventDefault()}
      >
        <span className="flex items-center gap-2">
          <Ban className="size-4" />
          <FormattedMessage {...msg.dontRecordMe} />
        </span>
        <Switch checked={signals.noRecord} onCheckedChange={signals.setNoRecord} />
      </label>
    </>
  );
}

/** Toasts when someone in the call starts or stops recording (Mumble logs the same). */
export function RecordingNotices() {
  const signals = useCallSignals().recording;
  const { user } = useCurrentUser();
  const nameOf = useCachedName();
  const seen = useRef<ReadonlySet<string> | null>(null);
  const recorders = signals?.recorders;
  const noRecord = signals?.noRecord ?? false;
  const noRecordRef = useRef(noRecord);
  noRecordRef.current = noRecord;

  useEffect(() => {
    if (!recorders) return;
    const before = seen.current ?? new Set<string>();
    seen.current = recorders;
    for (const pubkey of recorders) {
      if (pubkey === user?.pubkey || before.has(pubkey)) continue;
      toast({
        title: t(
          { id: "callRecorder.startedTitle", defaultMessage: "{name} is recording this call" },
          { name: nameOf(pubkey) },
        ),
        description: noRecordRef.current
          ? t({ id: "callRecorder.youRefuse", defaultMessage: "You block recording, so you aren't in it." })
          : t({
              id: "callRecorder.startedDescription",
              defaultMessage: "Your voice is being recorded. Block recording to be left out of it.",
            }),
        action: noRecordRef.current ? undefined : (
          <ToastAction altText={t(msg.dontRecordMe)} onClick={() => setNoRecord(true)}>
            {t(msg.dontRecordMe)}
          </ToastAction>
        ),
      });
    }
    for (const pubkey of before) {
      if (pubkey === user?.pubkey || recorders.has(pubkey)) continue;
      toast({
        title: t(
          { id: "callRecorder.stoppedByTitle", defaultMessage: "{name} stopped recording" },
          { name: nameOf(pubkey) },
        ),
      });
    }
  }, [recorders, user?.pubkey, nameOf]);

  return null;
}
