import { ArrowLeft, Folder, FolderGit2, Hash, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { OwnerAvatar, OwnerSlashRepo, RepositoryPicker, type PickedRepository } from "@/components/projects/RepositoryPicker";
import { Button } from "@/components/ui/button";
import { ChromeDialogContent, Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/hooks/useToast";
import { cn } from "@/lib/utils";
import { common, FormattedMessage, t, useIntl } from "@/i18n";

import { ChannelTypeStrip } from "@/concord/components/ChannelTypeStrip";
import type { ChannelView } from "@/concord/lib/types";

/** A chrome dialog sinks its fields into the background rather than outlining them. */
const WELL = "bg-background/40";
const FIELD = `border-transparent ${WELL}`;
const LABEL = "block text-xs font-medium uppercase tracking-wide text-muted-foreground";

/** The value the category picker holds for "no Category". */
const NO_CATEGORY = "none";

export interface NewTextChannelOptions {
  isPrivate?: boolean;
  accessRoleName?: string;
  view?: ChannelView;
  /** The vsk-13 Category it's made in, by id (CORD-03 §4). */
  category?: string;
}

export type WizardRepository = PickedRepository;

/** No chooser: the dialog opens on `text`; repo is a detour. */
type Step = "text" | "repo" | "confirm";

function StepGlyph({ children }: { children: ReactNode }) {
  return (
    <div className="flex size-16 items-center justify-center clip-corner-lg bg-primary/15 text-primary">
      {children}
    </div>
  );
}

/** Create a text/forum channel, or a repository channel tied to a NIP-34 repo. */
export function NewChannelDialog({ open, onOpenChange, connectedCoordinates, onCreateText, onCreateRepository, ranked = false, categories = [], initialCategory }: {
  open: boolean;
  /** On the vsk-13 Roster the Channel's permissions decide who reads it: no access role is asked for. */
  ranked?: boolean;
  /** The vsk-13 Categories it may be made in, in sidebar order. */
  categories?: ReadonlyArray<{ idHex: string; name: string }>;
  /** The Category it was opened from. */
  initialCategory?: string;
  onOpenChange: (open: boolean) => void;
  connectedCoordinates: ReadonlySet<string>;
  onCreateText: (name: string, opts?: NewTextChannelOptions) => Promise<unknown>;
  onCreateRepository: (name: string, repository: PickedRepository) => Promise<unknown>;
}) {
  const intl = useIntl();
  const [step, setStep] = useState<Step>("text");
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<PickedRepository | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // On ranked roles a Channel starts public and its permissions narrow who sees it (CORD-04 §8).
  const [isPrivate, setIsPrivate] = useState(!ranked);
  const [view, setView] = useState<ChannelView>("chat");
  const [category, setCategory] = useState<string>(initialCategory ?? NO_CATEGORY);
  // Display only; the binding is the role's scope (CORD-04 §2).
  const [roleName, setRoleName] = useState("");

  useEffect(() => {
    if (!open) return;
    setStep("text");
    setName("");
    setSelected(null);
    setCreating(false);
    setError(null);
    setIsPrivate(!ranked);
    setView("chat");
    setCategory(initialCategory ?? NO_CATEGORY);
    setRoleName("");
  }, [open, ranked, initialCategory]);

  const choose = useCallback((repository: PickedRepository) => {
    setSelected(repository);
    setName(repository.identifier.toLowerCase());
    setError(null);
    setStep("confirm");
  }, []);

  const create = useCallback(async () => {
    const channelName = name.trim();
    if (!channelName || creating) return;
    setError(null);
    setCreating(true);
    try {
      if (step === "confirm" && selected) {
        await onCreateRepository(channelName, selected);
        toast({
          title: t({ id: "newChannelDialog.repoCreated", defaultMessage: "Repository channel created" }),
          description: `#${channelName} · ${selected.displayName}`,
        });
      } else {
        // `chat` rides as an ABSENT field.
        const opts: NewTextChannelOptions = {
          ...(isPrivate ? { isPrivate: true, ...(ranked ? {} : { accessRoleName: roleName.trim() || undefined }) } : {}),
          ...(view !== "chat" ? { view } : {}),
          ...(ranked && category !== NO_CATEGORY ? { category } : {}),
        };
        await onCreateText(channelName, Object.keys(opts).length > 0 ? opts : undefined);
        // A newborn private channel's access role has no holders; point at granting it.
        toast(
          isPrivate
            ? {
                title:
                  view === "forum"
                    ? t({ id: "newChannelDialog.privateForumCreated", defaultMessage: "Private forum created" })
                    : t({ id: "newChannelDialog.privateChannelCreated", defaultMessage: "Private channel created" }),
                description: t(
                  {
                    id: "newChannelDialog.privateCreatedDescription",
                    defaultMessage:
                      "Only you can read #{name} so far. Use Add members in the channel menu to let others in.",
                  },
                  { name: channelName },
                ),
              }
            : {
                title:
                  view === "forum"
                    ? t({ id: "newChannelDialog.forumCreated", defaultMessage: "Forum created" })
                    : t({ id: "newChannelDialog.channelCreated", defaultMessage: "Channel created" }),
                description: `#${channelName}`,
              },
        );
      }
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : t({ id: "newChannelDialog.createFailed", defaultMessage: "Couldn't create the channel." }));
    } finally {
      setCreating(false);
    }
  }, [name, creating, step, selected, isPrivate, view, category, roleName, ranked, onCreateRepository, onCreateText, onOpenChange]);

  const back = step === "repo"
    ? () => setStep("text")
    : step === "confirm"
      ? () => setStep("repo")
      : undefined;

  return (
    <Dialog open={open} onOpenChange={(next) => !creating && onOpenChange(next)}>
      <ChromeDialogContent title={intl.formatMessage({ id: "newChannelDialog.title", defaultMessage: "Create a channel" })}>
        {back && (
          <Button
            variant="ghost"
            size="icon"
            className="absolute left-2 top-2 size-9 touch:size-11 text-muted-foreground hover:text-foreground"
            aria-label={intl.formatMessage(common.back)}
            disabled={creating}
            onClick={back}
          >
            <ArrowLeft className="size-5" />
          </Button>
        )}

        {/* min-w-0 stops unbreakable strings from widening the grid dialog. */}
        <div className="flex min-w-0 flex-col items-center gap-5 text-center">
          <StepGlyph>
            {step === "text" ? <Hash className="size-7" /> : <FolderGit2 className="size-7" />}
          </StepGlyph>

          <div className="space-y-1.5">
            <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground">
              {step === "text" ? (
                <FormattedMessage id="newChannelDialog.headingText" defaultMessage="new channel" />
              ) : step === "repo" ? (
                <FormattedMessage id="newChannelDialog.headingRepo" defaultMessage="choose a repository" />
              ) : (
                <FormattedMessage id="newChannelDialog.headingConfirm" defaultMessage="name the channel" />
              )}
            </h2>
            <p className="text-sm text-muted-foreground">
              {step === "text" ? (
                view === "forum" ? (
                  <FormattedMessage
                    id="newChannelDialog.forumDescription"
                    defaultMessage="Titled posts with comments. Discussions that stay findable."
                  />
                ) : (
                  <FormattedMessage
                    id="newChannelDialog.chatDescription"
                    defaultMessage="A live conversation for your community."
                  />
                )
              ) : step === "repo" ? (
                <FormattedMessage
                  id="newChannelDialog.repoDescription"
                  defaultMessage="Search the public directory, or paste an address from your git client."
                />
              ) : (
                <FormattedMessage
                  id="newChannelDialog.confirmDescription"
                  defaultMessage="Its activity appears in the channel and in Projects."
                />
              )}
            </p>
          </div>

          {step === "text" && (
            <form
              className="w-full min-w-0 space-y-4 text-left"
              onSubmit={(event) => {
                event.preventDefault();
                void create();
              }}
            >
              <div className="space-y-1.5">
                <label htmlFor="channel2-name" className={LABEL}>
                  <FormattedMessage id="newChannelDialog.channelName" defaultMessage="Channel name" />
                </label>
                <Input
                  id="channel2-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={intl.formatMessage({
                    id: "newChannelDialog.namePlaceholder",
                    defaultMessage: "e.g. general, memes, dev-talk",
                  })}
                  autoComplete="off"
                  autoFocus
                  disabled={creating}
                  className={FIELD}
                />
              </div>

              <div className="space-y-1.5">
                <div aria-hidden className={LABEL}>
                  <FormattedMessage id="newChannelDialog.channelType" defaultMessage="Channel type" />
                </div>
                <ChannelTypeStrip value={view} onChange={setView} disabled={creating} className={WELL} />
              </div>

              {ranked && categories.length > 0 && (
                <div className="space-y-1.5">
                  <div aria-hidden className={LABEL}>
                    <FormattedMessage id="newChannelDialog.category" defaultMessage="Category" />
                  </div>
                  <Select value={category} onValueChange={setCategory} disabled={creating}>
                    <SelectTrigger className={FIELD} aria-label={intl.formatMessage({ id: "newChannelDialog.category", defaultMessage: "Category" })}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_CATEGORY}>
                        <FormattedMessage id="newChannelDialog.noCategory" defaultMessage="No category" />
                      </SelectItem>
                      {categories.map((c) => (
                        <SelectItem key={c.idHex} value={c.idHex}>
                          <span className="inline-flex items-center gap-1.5">
                            <Folder className="size-3.5 text-muted-foreground" />
                            {c.name || c.idHex.slice(0, 8)}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <label htmlFor="channel2-private" className={cn("flex cursor-pointer items-center gap-3 rounded-md px-3 py-2.5", WELL)}>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">
                    <FormattedMessage id="newChannelDialog.privateChannel" defaultMessage="Private channel" />
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {ranked ? (
                      <FormattedMessage
                        id="newChannelDialog.privateChannelDescriptionRanked"
                        defaultMessage="Its own key, and its permissions decide who can read it."
                      />
                    ) : (
                      <FormattedMessage
                        id="newChannelDialog.privateChannelDescription"
                        defaultMessage="Its own key, and a role that decides who can read it."
                      />
                    )}
                  </span>
                </span>
                <Switch id="channel2-private" checked={isPrivate} onCheckedChange={setIsPrivate} disabled={creating} />
              </label>
              {ranked && (
                <p className="text-xs text-muted-foreground">
                  <FormattedMessage
                    id="newChannelDialog.rankedPermissionsHint"
                    defaultMessage="To hide a channel or limit who can post, open Permissions from its menu once it's created. That works on public channels too."
                  />
                </p>
              )}
              {isPrivate && !ranked && (
                <div className="space-y-1.5">
                  <label htmlFor="channel2-role" className={LABEL}>
                    <FormattedMessage id="newChannelDialog.roleName" defaultMessage="Access role name" />
                  </label>
                  <Input
                    id="channel2-role"
                    value={roleName}
                    onChange={(event) => setRoleName(event.target.value)}
                    placeholder={
                      name.trim()
                        ? intl.formatMessage(
                            { id: "newChannelDialog.rolePlaceholderNamed", defaultMessage: "Role name (default: {name})" },
                            { name: name.trim() },
                          )
                        : intl.formatMessage({
                            id: "newChannelDialog.rolePlaceholder",
                            defaultMessage: "Role name (default: channel name)",
                          })
                    }
                    disabled={creating}
                    maxLength={64}
                    className={FIELD}
                  />
                  <p className="text-xs text-muted-foreground">
                    <FormattedMessage
                      id="newChannelDialog.roleHint"
                      defaultMessage="Holders of this role can read the channel. More roles can be added later."
                    />
                  </p>
                </div>
              )}

              {error && <p className="text-xs text-destructive">{error}</p>}

              <Button
                type="submit"
                size="lg"
                disabled={creating || !name.trim()}
                className="h-12 w-full clip-corner-lg text-base font-medium"
              >
                {creating ? <Loader2 className="size-4 animate-spin" /> : (
                  <FormattedMessage id="newChannelDialog.createChannel" defaultMessage="Create channel" />
                )}
              </Button>

              <div className="flex items-center gap-3 pt-1">
                <span className="h-px flex-1 bg-border" />
                <span className="text-2xs uppercase tracking-wider text-muted-foreground">
                  <FormattedMessage id="newChannelDialog.or" defaultMessage="or" />
                </span>
                <span className="h-px flex-1 bg-border" />
              </div>
              <Button
                type="button"
                variant="ghost"
                disabled={creating}
                onClick={() => setStep("repo")}
                className="w-full text-muted-foreground hover:text-foreground"
              >
                <FolderGit2 className="size-4" />
                <FormattedMessage id="newChannelDialog.connectRepo" defaultMessage="Connect a git repository" />
              </Button>
            </form>
          )}

          {step === "repo" && (
            <div className="w-full min-w-0 text-left">
              <RepositoryPicker connectedCoordinates={connectedCoordinates} onSelect={choose} />
            </div>
          )}

          {step === "confirm" && selected && (
            <form
              className="w-full min-w-0 space-y-3 text-left"
              onSubmit={(event) => {
                event.preventDefault();
                void create();
              }}
            >
              <div className="flex min-w-0 items-center gap-2.5 rounded-lg bg-secondary/50 p-3">
                <OwnerAvatar pubkey={selected.owner} />
                <span className="min-w-0 flex-1">
                  <OwnerSlashRepo owner={selected.owner} name={selected.displayName} />
                </span>
              </div>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={intl.formatMessage({ id: "newChannelDialog.channelName", defaultMessage: "Channel name" })}
                aria-label={intl.formatMessage({ id: "newChannelDialog.channelName", defaultMessage: "Channel name" })}
                autoFocus
                disabled={creating}
                className={cn("h-12 text-base", FIELD)}
              />
              {error && <p className="text-xs text-destructive">{error}</p>}
              <Button
                type="submit"
                size="lg"
                disabled={creating || !name.trim()}
                className="h-12 w-full clip-corner-lg text-base font-medium"
              >
                {creating ? <Loader2 className="size-4 animate-spin" /> : (
                  <FormattedMessage id="newChannelDialog.createRepoChannel" defaultMessage="Create repository channel" />
                )}
              </Button>
            </form>
          )}
        </div>
      </ChromeDialogContent>
    </Dialog>
  );
}
