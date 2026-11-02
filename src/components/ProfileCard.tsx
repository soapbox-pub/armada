import React, { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { NostrMetadata } from '@nostrify/nostrify';
import { DisplayName } from '@/components/DisplayName';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { type AvatarShape, isValidAvatarShape, isEmoji, getAvatarMaskUrlAsync, shapedAvatarBorderStyle } from '@/lib/avatarShape';
import { CheckCircle2, Pencil, Plus, Trash2, ChevronDown, ImagePlus, SmilePlus, X as XIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ChromeDialogContent, ChromeDialogFooter, ChromeDialogHeader, Dialog } from '@/components/ui/dialog';
import type { EmojiSelection } from '@/components/chat/EmojiPicker';
import { getPronouns, MAX_PRONOUNS_LENGTH } from '@/lib/pronouns';
import { sanitizeImageSrc } from '@/lib/sanitizeUrl';
import { FallbackImage } from '@/components/ui/FallbackImage';
import type { ProfileImeta } from '@/lib/profileImeta';
import { FormattedMessage, useIntl } from '@/i18n';
import { AvatarInitial } from '@/components/AvatarInitial';

/** Lazy so emoji-mart (~420 KB data) stays out of this chunk; only used behind the avatar-shape dialog. */
const LazyEmojiPicker = lazy(() =>
  import('@/components/chat/EmojiPicker').then((m) => ({ default: m.EmojiPicker })),
);

const editableBase = [
  'rounded-lg px-2',
  'border-2 border-transparent',
  'bg-muted/40',
  'hover:bg-muted/60 hover:border-border',
  'focus:bg-transparent focus:border-primary',
  'transition-colors duration-150',
  'placeholder:text-muted-foreground/40',
  'outline-none',
].join(' ');

function EditableInput({
  value,
  placeholder,
  onChange,
  className,
  maxLength,
  ariaLabel,
}: {
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  className?: string;
  maxLength?: number;
  ariaLabel?: string;
}) {
  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      maxLength={maxLength}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
      className={cn(editableBase, 'w-full min-w-0 py-0.5', className)}
    />
  );
}

function EditableTextarea({
  value,
  placeholder,
  onChange,
  className,
}: {
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  className?: string;
}) {
  return (
    <textarea
      value={value}
      placeholder={placeholder}
      onChange={(e) => {
        onChange(e.target.value);
        e.target.style.height = 'auto';
        e.target.style.height = e.target.scrollHeight + 'px';
      }}
      onFocus={(e) => {
        e.target.style.height = 'auto';
        e.target.style.height = e.target.scrollHeight + 'px';
      }}
      rows={1}
      className={cn(editableBase, 'w-full min-w-0 py-1 resize-none overflow-hidden text-base md:text-sm text-muted-foreground leading-relaxed', className)}
    />
  );
}

export interface ProfileField {
  label: string;
  value: string;
}

export interface ProfileCardProps {
  pubkey?: string;
  metadata: Partial<NostrMetadata>;
  /** The kind 0's imeta for `picture`/`banner`; entries for edited URLs are ignored. */
  imeta?: ProfileImeta;
  onChange?: (patch: Partial<NostrMetadata>) => void;
  onPickImage?: (field: 'picture' | 'banner') => void;
  /** Called with an emoji string, or empty to clear. */
  onAvatarShape?: (shape: string) => void;
  onRemoveAvatar?: () => void;
  showNip05?: boolean;
  /** When provided, render an editable profile fields section below bio. */
  extraFields?: ProfileField[];
  onExtraFieldsChange?: (fields: ProfileField[]) => void;
}

export function ProfileCard({
  pubkey,
  metadata,
  imeta,
  onChange,
  onPickImage,
  onAvatarShape,
  onRemoveAvatar,
  showNip05 = true,
  extraFields,
  onExtraFieldsChange,
}: ProfileCardProps) {
  const intl = useIntl();
  const editable = !!onChange;
  const [nip05Focused, setNip05Focused] = useState(false);
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);

  const displayName = metadata.name || metadata.display_name || intl.formatMessage({ id: 'profileCard.anonymous', defaultMessage: 'Anonymous' });
  const initial = <AvatarInitial name={displayName} />;
  const patch = (key: keyof NostrMetadata) => (v: string) => onChange?.({ [key]: v });

  const bannerUrl = sanitizeImageSrc(metadata.banner);

  const rawShape = (metadata as { shape?: unknown }).shape;
  const shape: AvatarShape | undefined = isValidAvatarShape(rawShape) ? rawShape : undefined;
  const isEmojiShape = !!shape && isEmoji(shape);
  const hasCustomShape = isEmojiShape;

  const [overlayMaskUrl, setOverlayMaskUrl] = useState<string>('');

  useEffect(() => {
    if (!hasCustomShape || !shape) {
      setOverlayMaskUrl('');
      return;
    }

    let cancelled = false;
    getAvatarMaskUrlAsync(shape).then((url) => {
      if (!cancelled) {
        setOverlayMaskUrl(url);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [hasCustomShape, shape]);

  const overlayMaskStyle = useMemo<React.CSSProperties | undefined>(() => {
    if (!overlayMaskUrl) return undefined;
    return {
      WebkitMaskImage: `url(${overlayMaskUrl})`,
      maskImage: `url(${overlayMaskUrl})`,
      WebkitMaskSize: 'contain',
      maskSize: 'contain' as string,
      WebkitMaskRepeat: 'no-repeat',
      maskRepeat: 'no-repeat' as string,
      WebkitMaskPosition: 'center',
      maskPosition: 'center' as string,
    };
  }, [overlayMaskUrl]);

  const nip05 = metadata.nip05;
  const pronouns = getPronouns(metadata);

  const addField = () => onExtraFieldsChange?.([...(extraFields ?? []), { label: '', value: '' }]);
  const removeField = (i: number) => onExtraFieldsChange?.((extraFields ?? []).filter((_, idx) => idx !== i));
  const updateField = (i: number, key: keyof ProfileField, val: string) =>
    onExtraFieldsChange?.((extraFields ?? []).map((f, idx) => idx === i ? { ...f, [key]: val } : f));

  return (
    <div className="bg-card rounded-xl overflow-hidden">

      <div
        className={cn('relative h-36 bg-secondary', editable && 'cursor-pointer group')}
        onClick={() => editable && onPickImage?.('banner')}
      >
        {/* An <img>, not a CSS background, so it can walk mirrors and decrypt. */}
        <FallbackImage src={bannerUrl} imeta={imeta?.banner} className="absolute inset-0 size-full object-cover" />
        {!metadata.banner && <div className="absolute inset-0 bg-gradient-to-br from-accent/10 via-transparent to-primary/5" />}
        {editable && !metadata.banner && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Plus className="size-6 text-muted-foreground" strokeWidth={4} />
          </div>
        )}
        {editable && (
          <>
            {/* Hover affordances only; on touch the card is obviously tappable. */}
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
              <span className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1.5 text-white text-xs font-medium bg-black/50 rounded-full px-3 py-1.5 backdrop-blur-sm">
                <Pencil className="size-3.5" />{' '}
                {metadata.banner ? (
                  <FormattedMessage id="profileCard.changeBanner" defaultMessage="Change banner" />
                ) : (
                  <FormattedMessage id="profileCard.addBanner" defaultMessage="Add banner" />
                )}
              </span>
            </div>
            {metadata.banner && (
              <div className="absolute bottom-2 right-2 size-7 rounded-full bg-background border border-border shadow-sm flex items-center justify-center transition-opacity touch:hidden">
                <Pencil className="size-3.5 text-muted-foreground" />
              </div>
            )}
          </>
        )}
      </div>

      <div className="px-4 pb-4">

        <div className="flex justify-between items-start -mt-12 mb-3">
          {editable ? (
            <>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" className="relative shrink-0 cursor-pointer group outline-none">
                    <div style={hasCustomShape ? shapedAvatarBorderStyle : undefined}>
                      <Avatar shape={shape} className={cn("shadow-sm", hasCustomShape ? "size-[88px]" : "size-24 border-4 border-background")}>
                        <AvatarImage src={metadata.picture} imeta={imeta?.picture} alt={displayName} className="object-cover" />
                        <AvatarFallback className="bg-primary/20 text-primary text-2xl font-bold">
                          {metadata.picture ? initial : <Plus className="size-8 text-muted-foreground" strokeWidth={4} />}
                        </AvatarFallback>
                      </Avatar>
                    </div>
                    <div
                      className={cn(
                        'absolute inset-0 bg-black/0 group-hover:bg-black/45 transition-colors flex items-center justify-center',
                        !hasCustomShape && 'rounded-full',
                      )}
                      style={overlayMaskStyle}
                    >
                      <Pencil className="size-6 text-white opacity-0 group-hover:opacity-100 transition-opacity drop-shadow" />
                    </div>
                    {metadata.picture && (
                      <div className="absolute bottom-0 right-0 size-7 rounded-full bg-background border border-border shadow-sm flex items-center justify-center transition-opacity touch:hidden">
                        <Pencil className="size-3.5 text-muted-foreground" />
                      </div>
                    )}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" sideOffset={6}>
                  <DropdownMenuItem onClick={() => onPickImage?.('picture')}>
                    <ImagePlus className="size-4 mr-2" />
                    <FormattedMessage id="profileCard.changeAvatar" defaultMessage="Change avatar" />
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setEmojiPickerOpen(true)}>
                    <SmilePlus className="size-4 mr-2" />
                    <FormattedMessage id="profileCard.setAvatarShape" defaultMessage="Set avatar shape" />
                  </DropdownMenuItem>
                  {metadata.picture && (
                    <DropdownMenuItem onClick={() => onRemoveAvatar?.()} className="text-destructive focus:text-destructive">
                      <XIcon className="size-4 mr-2" />
                      <FormattedMessage id="profileCard.removeAvatar" defaultMessage="Remove avatar" />
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>

              <Dialog open={emojiPickerOpen} onOpenChange={setEmojiPickerOpen}>
                {/* `w-fit` needs the card to have an intrinsic width, which an inline-size container lacks. */}
                <ChromeDialogContent
                  title={intl.formatMessage({ id: 'profileCard.setAvatarShape', defaultMessage: 'Set avatar shape' })}
                  className="w-fit max-w-[calc(100vw-2rem)] sm:max-w-[calc(100vw-2rem)]"
                  contentClassName="p-4 sm:p-5 [container-type:normal]"
                >
                  <ChromeDialogHeader
                    icon={SmilePlus}
                    title={intl.formatMessage({ id: 'profileCard.shapeDialog.title', defaultMessage: 'set avatar shape' })}
                    description={intl.formatMessage({
                      id: 'profileCard.shapeDialog.description',
                      defaultMessage: 'Pick an emoji to mask your avatar',
                    })}
                    className="mb-4"
                  />
                  <Suspense fallback={<div className="h-[360px] w-[352px] max-w-[calc(100vw-4rem)]" />}>
                    <LazyEmojiPicker onSelect={(selection: EmojiSelection) => {
                      if (selection.type === 'native') {
                        onAvatarShape?.(selection.emoji);
                        setEmojiPickerOpen(false);
                      }
                    }} />
                  </Suspense>
                  {hasCustomShape && (
                    <ChromeDialogFooter className="mt-4">
                      <Button
                        type="button"
                        variant="secondary"
                        className="text-destructive hover:text-destructive"
                        onClick={() => { onAvatarShape?.(''); setEmojiPickerOpen(false); }}
                      >
                        <XIcon className="size-3.5 mr-1.5" />
                        <FormattedMessage id="profileCard.removeAvatarShape" defaultMessage="Remove avatar shape" />
                      </Button>
                    </ChromeDialogFooter>
                  )}
                </ChromeDialogContent>
              </Dialog>
            </>
          ) : (
            <div className="relative shrink-0" style={hasCustomShape ? shapedAvatarBorderStyle : undefined}>
              <Avatar shape={shape} className={cn("shadow-sm", hasCustomShape ? "size-[88px]" : "size-24 border-4 border-background")}>
                <AvatarImage src={metadata.picture} imeta={imeta?.picture} alt={displayName} className="object-cover" />
                <AvatarFallback className="bg-primary/20 text-primary text-2xl font-bold">
                  {initial}
                </AvatarFallback>
              </Avatar>
            </div>
          )}
        </div>

        {editable ? (
          <EditableInput
            value={metadata.name ?? ''}
            placeholder={intl.formatMessage({ id: 'profileCard.namePlaceholder', defaultMessage: 'Your name' })}
            onChange={patch('name')}
            className="text-xl font-bold"
          />
        ) : (
          <h2 className="text-xl font-bold truncate">
            <DisplayName pubkey={pubkey} name={displayName} />
          </h2>
        )}

        {editable ? (
          <EditableInput
            value={typeof metadata.pronouns === 'string' ? metadata.pronouns : ''}
            placeholder={intl.formatMessage({ id: 'profileCard.pronounsPlaceholder', defaultMessage: 'Pronouns, e.g. they/them' })}
            ariaLabel={intl.formatMessage({ id: 'profileCard.pronouns', defaultMessage: 'Pronouns' })}
            maxLength={MAX_PRONOUNS_LENGTH}
            onChange={patch('pronouns')}
            className="mt-1 text-base md:text-sm text-muted-foreground"
          />
        ) : pronouns ? (
          <p className="text-sm text-muted-foreground truncate">{pronouns}</p>
        ) : null}

        {showNip05 && (editable || nip05) && (
          <div className="flex items-center gap-1 mt-2 min-w-0 text-sm text-muted-foreground ml-2">
            <CheckCircle2 className="size-3.5 text-primary shrink-0" />
            {editable && nip05Focused ? (
              <input
                type="text"
                value={nip05 ?? ''}
                placeholder="you@domain.com"
                autoFocus
                onChange={(e) => patch('nip05')(e.target.value)}
                onBlur={() => setNip05Focused(false)}
                size={Math.max((nip05?.length ?? 0) + 1, 4)}
                className={cn(editableBase, 'py-0.5 h-6 text-base md:text-sm text-muted-foreground border-primary bg-transparent')}
              />
            ) : (
              <span
                className={cn(
                  'inline-flex items-center gap-1 min-w-0',
                  editable && cn(editableBase, 'py-0.5 h-6 cursor-text'),
                )}
                onClick={() => editable && setNip05Focused(true)}
              >
                <span className="shrink min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                  {nip05 ? nip05.replace(/^_@/, '') : editable ? 'you@domain.com' : ''}
                </span>
              </span>
            )}
          </div>
        )}

        <div className="mt-2">
          {editable ? (
            <EditableTextarea
              value={metadata.about ?? ''}
              placeholder={intl.formatMessage({ id: 'profileCard.bioPlaceholder', defaultMessage: 'Write a short bio…' })}
              onChange={patch('about')}
            />
          ) : metadata.about ? (
            <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap">
              {metadata.about}
            </p>
          ) : null}
        </div>

        {extraFields !== undefined && (
          <Collapsible open={fieldsOpen} onOpenChange={setFieldsOpen} className="mt-3">
            <div className="flex items-center justify-between">
              <CollapsibleTrigger asChild>
                <Button type="button" variant="ghost" className="w-full justify-between px-0 h-auto hover:bg-transparent text-sm font-medium text-muted-foreground">
                  <FormattedMessage id="profileCard.fields" defaultMessage="Profile Fields" />
                  <ChevronDown className="size-4 transition-transform duration-200 [[data-state=open]_&]:rotate-180" strokeWidth={4} />
                </Button>
              </CollapsibleTrigger>
            </div>
            <CollapsibleContent className="space-y-2 pt-2">
              <div className="grid grid-cols-[1fr,2fr] gap-2 items-center">
                <span className="text-sm text-muted-foreground px-1">
                  <FormattedMessage id="profileCard.website" defaultMessage="Website" />
                </span>
                <Input
                  placeholder="https://yourwebsite.com"
                  value={(metadata.website as string) ?? ''}
                  onChange={(e) => patch('website')(e.target.value)}
                  className="h-8 text-base md:text-sm"
                />
              </div>

              {extraFields.map((field, i) => (
                <div key={i} className="grid grid-cols-[1fr,2fr,auto] gap-2 items-center">
                  <Input
                    placeholder={intl.formatMessage({ id: 'profileCard.fieldLabel', defaultMessage: 'Label' })}
                    value={field.label}
                    onChange={(e) => updateField(i, 'label', e.target.value)}
                    className="h-8 text-base md:text-sm"
                  />
                  <Input
                    placeholder={intl.formatMessage({ id: 'profileCard.fieldValue', defaultMessage: 'Value or URL' })}
                    value={field.value}
                    onChange={(e) => updateField(i, 'value', e.target.value)}
                    className="h-8 text-base md:text-sm"
                  />
                  <Button type="button" variant="ghost" size="icon" onClick={() => removeField(i)} className="size-8 touch:size-11 text-destructive hover:text-destructive">
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}

              <Button type="button" variant="outline" size="sm" onClick={addField} className="w-full h-8 text-xs">
                <Plus className="size-3 mr-1" strokeWidth={4} />{' '}
                <FormattedMessage id="profileCard.addField" defaultMessage="Add Field" />
              </Button>
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
    </div>
  );
}
