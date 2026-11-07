import { cn } from "@/lib/utils";

const RIBBON = "bg-gradient-to-b from-amber-100 via-amber-300 to-amber-500";
const WRAP = "bg-gradient-to-br from-primary via-fuchsia-500 to-accent2";

/**
 * A wrapped Armada Ultra gift, drawn in CSS so it scales to any size: sized by
 * the caller (`className="size-40"`). `open` throws the lid off and lets the
 * light out; `shaking` rattles it just before.
 */
export function GiftBox({ open, shaking, bob = true, rays = true, className }: {
  open?: boolean;
  shaking?: boolean;
  bob?: boolean;
  rays?: boolean;
  className?: string;
}) {
  return (
    <div aria-hidden className={cn("relative aspect-square shrink-0", className)}>
      {rays && (
        <div
          className={cn(
            "absolute inset-[-45%] rounded-full transition-opacity duration-700 motion-safe:animate-[spin_24s_linear_infinite]",
            "bg-[repeating-conic-gradient(hsl(var(--warning)/0.28)_0deg_7deg,transparent_7deg_22deg)]",
            "[mask-image:radial-gradient(circle,black_15%,transparent_68%)]",
            open ? "opacity-100" : "opacity-50",
          )}
        />
      )}
      <div
        className={cn(
          "absolute inset-[-12%] rounded-full blur-2xl transition-opacity duration-700",
          "bg-[radial-gradient(circle,hsl(var(--primary)/0.65),transparent_68%)]",
          open ? "opacity-100" : "opacity-70",
        )}
      />

      <div className={cn("absolute inset-0", bob && !open && !shaking && "motion-safe:animate-gift-bob", shaking && "motion-safe:animate-gift-shake")}>
        {open && (
          <>
            <div className="absolute left-1/2 top-[40%] size-[70%] rounded-full bg-[radial-gradient(circle,white,hsl(var(--warning)/0.8)_35%,transparent_70%)] motion-safe:animate-gift-burst" />
            <div className="absolute inset-x-[16%] top-[30%] h-[22%] rounded-[50%] bg-[radial-gradient(ellipse_at_bottom,hsl(var(--warning)/0.9),transparent_70%)] blur-md" />
          </>
        )}

        {open && (
          // Centered by insets: gift-reveal's keyframes own `transform`.
          <div className="absolute inset-x-[24%] top-[-6%] h-[52%] motion-safe:animate-gift-reveal [animation-delay:250ms]">
            <div className="flex size-full items-center justify-center [container-type:size] motion-safe:animate-gift-bob">
              <span className="font-emoji leading-none drop-shadow-[0_0_18px_rgba(255,255,255,0.8)]" style={{ fontSize: "80cqh" }}>
                💎
              </span>
            </div>
          </div>
        )}

        {/* Body */}
        <div className={cn("absolute inset-x-[12%] bottom-[4%] top-[40%] overflow-hidden rounded-b-[14%] rounded-t-[4%] shadow-2xl shadow-primary/40", WRAP)}>
          <div className={cn("absolute inset-y-0 left-1/2 w-[17%] -translate-x-1/2 shadow-[0_0_8px_rgba(0,0,0,0.25)]", RIBBON)} />
          <div className="absolute inset-x-0 top-0 h-[16%] bg-gradient-to-b from-black/30 to-transparent" />
          <div className="absolute -left-1/4 top-0 h-full w-1/3 -skew-x-12 bg-white/15" />
        </div>

        {/* Lid and bow */}
        <div
          className={cn(
            "absolute inset-x-[6%] top-[27%] h-[16%] transition-all duration-700 [transition-timing-function:cubic-bezier(0.2,1.3,0.4,1)]",
            open && "-translate-y-[260%] translate-x-[18%] rotate-[24deg] opacity-0",
          )}
        >
          <div className={cn("absolute inset-0 overflow-hidden rounded-[18%] shadow-lg", WRAP)}>
            <div className={cn("absolute inset-y-0 left-1/2 w-[16%] -translate-x-1/2", RIBBON)} />
            <div className="absolute inset-x-0 top-0 h-1/3 bg-white/20" />
          </div>
          <div className="absolute bottom-[78%] left-1/2 h-[150%] w-[52%] -translate-x-1/2">
            <div className={cn("absolute bottom-[8%] right-[46%] h-[78%] w-[52%] origin-bottom-right -rotate-[28deg] rounded-[60%_60%_30%_60%] shadow-md", RIBBON)}>
              <div className="absolute inset-[26%] rounded-full bg-amber-600/50" />
            </div>
            <div className={cn("absolute bottom-[8%] left-[46%] h-[78%] w-[52%] origin-bottom-left rotate-[28deg] rounded-[60%_60%_60%_30%] shadow-md", RIBBON)}>
              <div className="absolute inset-[26%] rounded-full bg-amber-600/50" />
            </div>
            <div className={cn("absolute bottom-0 left-1/2 h-[36%] w-[24%] -translate-x-1/2 rounded-[40%] shadow", RIBBON)} />
          </div>
        </div>
      </div>
    </div>
  );
}
