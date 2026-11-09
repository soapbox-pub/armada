import { UltraEffect } from "@/components/UltraEffect";
import { UltraPill } from "@/components/UltraPill";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { FormattedMessage } from "@/i18n";
import { getAvatarShape } from "@/lib/avatarShape";
import {
  AVATAR_FRAMES,
  frameCss,
  NAME_STYLES,
  nameStyleCss,
  ULTRA_NAME_CLASS,
  ULTRA_THEMES,
  type AvatarFrameId,
  type NameStyleId,
  type ProfileEffectId,
} from "@/lib/ultra";
import { cn } from "@/lib/utils";

import type { NostrMetadata } from "@nostrify/nostrify";
import type { ReactNode } from "react";

import type { AuthorResult } from "@/lib/authorCache";
import { AvatarInitial } from "@/components/AvatarInitial";

/** Who the mock-ups are drawn as: the viewer, so they see themselves with the perk. */
export interface UltraSelf {
  name: string;
  metadata?: NostrMetadata;
  imeta?: AuthorResult["imeta"];
}

export function UltraName({ name, style, className }: { name: string; style: NameStyleId | undefined; className?: string }) {
  return (
    <span className={cn("truncate font-semibold", style && ULTRA_NAME_CLASS, className)} style={nameStyleCss(style)}>
      {name}
    </span>
  );
}

export function UltraAvatar({ self, frame, className }: { self: UltraSelf; frame: AvatarFrameId | undefined; className?: string }) {
  return (
    <span className="shrink-0 rounded-full" style={frameCss(frame)}>
      <Avatar shape={getAvatarShape(self.metadata)} className={cn("size-10", className)}>
        <AvatarImage src={self.metadata?.picture} imeta={self.imeta?.picture} alt={self.name} />
        <AvatarFallback className="bg-primary/20 text-primary text-sm"><AvatarInitial name={self.name} /></AvatarFallback>
      </Avatar>
    </span>
  );
}

/** A chat message as everyone sees it from an Ultra member. */
export function UltraMessage({ self, name, frame, children }: { self: UltraSelf; name?: NameStyleId; frame?: AvatarFrameId; children?: ReactNode }) {
  return (
    <div className="flex w-full max-w-xs items-start gap-2.5 text-left">
      <UltraAvatar self={self} frame={frame} className="size-9" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <UltraName name={self.name} style={name} className="text-sm" />
          <UltraPill force interactive={false} />
        </div>
        <p className="text-sm text-foreground/90">
          {children ?? <FormattedMessage id="ultraIllustrations.message" defaultMessage="gm everyone, I'm Ultra now ✨" />}
        </p>
      </div>
    </div>
  );
}

export function NameStylesIllustration({ self }: { self: UltraSelf }) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      {(Object.keys(NAME_STYLES) as NameStyleId[]).slice(0, 3).map((id) => (
        <UltraName key={id} name={self.name} style={id} className="max-w-48 text-lg leading-snug" />
      ))}
    </div>
  );
}

export function FramesIllustration({ self }: { self: UltraSelf }) {
  return (
    <div className="flex items-center gap-3">
      {(Object.keys(AVATAR_FRAMES) as AvatarFrameId[]).slice(0, 4).map((id) => (
        <UltraAvatar key={id} self={self} frame={id} className="size-11" />
      ))}
    </div>
  );
}

/** A mini profile card with the effect bursting over it on a loop. */
export function EffectIllustration({ self, effect, frame, name }: { self: UltraSelf; effect: ProfileEffectId; frame?: AvatarFrameId; name?: NameStyleId }) {
  return (
    <div className="relative w-40 overflow-hidden rounded-lg bg-background/80 shadow-lg">
      <div className="h-8 bg-gradient-to-r from-primary/50 to-accent2/50" />
      <div className="px-3 pb-3">
        <div className="-mt-5 mb-1">
          <UltraAvatar self={self} frame={frame} className="size-10 border-2 border-background" />
        </div>
        <UltraName name={self.name} style={name} className="block text-sm" />
      </div>
      <UltraEffect effect={effect} loop />
    </div>
  );
}

export function ThemesIllustration() {
  return (
    <div className="flex items-end gap-2">
      {Object.entries(ULTRA_THEMES).map(([id, theme], i) => (
        <ThemeWindow key={id} colors={theme.colors} className={i === 1 ? "h-20 w-24" : "h-16 w-20"} />
      ))}
    </div>
  );
}

export function ThemeWindow({ colors, className }: { colors: { background: string; text: string; primary: string }; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-1 overflow-hidden rounded-md p-1.5 shadow-md", className)} style={{ backgroundColor: `hsl(${colors.background})` }}>
      <div className="flex gap-0.5">
        {[0, 1, 2].map((i) => <span key={i} className="size-1 rounded-full" style={{ backgroundColor: `hsl(${colors.text} / 0.4)` }} />)}
      </div>
      <span className="h-1 w-3/4 rounded-full" style={{ backgroundColor: `hsl(${colors.text} / 0.7)` }} />
      <span className="h-1 w-1/2 rounded-full" style={{ backgroundColor: `hsl(${colors.text} / 0.4)` }} />
      <span className="mt-auto h-2 w-2/3 self-end rounded-sm" style={{ backgroundColor: `hsl(${colors.primary})` }} />
    </div>
  );
}
