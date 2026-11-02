import { isAnonymousName } from "@/lib/getDisplayName";
import { cn } from "@/lib/utils";

/** A hat and glasses, drawn in `currentColor` to fill an avatar's circle. */
export function AnonymousFigure({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn("size-full", className)} fill="currentColor">
      <g transform="translate(12 12) scale(1.15) translate(-12 -9.8)">
        <path d="M7.6 8.6 8.7 4.3c.2-.7.8-1 1.5-.8l1.8.5 1.8-.5c.7-.2 1.3.1 1.5.8l1.1 4.3Z" />
        <rect x="3.6" y="8.9" width="16.8" height="1.9" rx=".95" />
        <g fill="none" stroke="currentColor" strokeWidth="1.4">
          <circle cx="8.9" cy="14" r="2.1" />
          <circle cx="15.1" cy="14" r="2.1" />
          <path d="M11 13.7q1-.7 2 0" strokeLinecap="round" />
        </g>
      </g>
    </svg>
  );
}

/** A person's avatar fallback: their initial, or {@link AnonymousFigure} while they have no name. */
export function AvatarInitial({ name }: { name: string | undefined }) {
  if (isAnonymousName(name)) return <AnonymousFigure />;
  return <>{name?.trim()[0]?.toUpperCase() || "?"}</>;
}
