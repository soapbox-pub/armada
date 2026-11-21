import { useState } from "react";

import { HeroP2pPerson, P2pTile } from "@/components/chat/CallStage";
import { fitGrid, heroSize, useElementSize } from "@/components/chat/callStageLayout";
import { IrohCallControls, type IrohCallControlsProps } from "@/components/IrohCallBar";
import { useCall } from "@/hooks/useCall";
import { useIsDesktop } from "@/hooks/useIsDesktop";
import { useIntl } from "@/i18n";
import type { P2pCallView } from "@/lib/irohVoice/peers";
import { cn } from "@/lib/utils";

/**
 * The stage of a call that is peer to peer alone: everyone large while nobody shows video,
 * a grid of cameras and screens once someone does — the people and pictures `CallStage`
 * shows from LiveKit, here from the iroh links.
 */
export function IrohCallStage({
  view,
  open,
  callLabel,
  controls,
}: {
  view: P2pCallView;
  open: boolean;
  callLabel: React.ReactNode;
  controls: IrohCallControlsProps;
}) {
  const { stageFloating, exiting } = useCall();
  const isDesktop = useIsDesktop();
  const intl = useIntl();
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [gridRef, gridSize] = useElementSize<HTMLDivElement>();
  const self = view.self;
  if (!open || stageFloating) return null;

  type Tile = { key: string; node: (focused: boolean) => React.ReactNode };
  const tiles: Tile[] = [];
  const people = [...view.peers.map((p) => ({ ...p, self: false })), ...(self ? [{ ...self, self: true, sending: { camera: Boolean(self.camera), screen: Boolean(self.screen) } }] : [])];
  for (const p of people) {
    for (const kind of ["camera", "screen"] as const) {
      const track = p[kind];
      if (kind === "screen" && !track) continue;
      const key = `${p.pubkey}:${track ? kind : "avatar"}`;
      tiles.push({
        key,
        node: (focused) => (
          <P2pTile
            pubkey={p.pubkey}
            self={p.self}
            kind={kind}
            track={track}
            speaking={p.speaking}
            muted={p.muted}
            focused={focused}
            onToggleFocus={() => setFocusKey((cur) => (cur === key ? null : key))}
          />
        ),
      });
    }
  }
  const hasVideo = people.some((p) => p.camera || p.screen);
  const focused = focusKey ? tiles.find((t) => t.key === focusKey) : undefined;
  const grid = fitGrid(tiles.length, gridSize.width, gridSize.height, 8);
  const size = heroSize(people.length, false, isDesktop);

  return (
    <div
      className={cn(
        "shrink-0 mx-gutter mt-stack",
        exiting ? "animate-out fade-out-0 slide-out-to-top-2 duration-200 fill-mode-forwards" : "animate-in fade-in-0 slide-in-from-top-2 duration-200",
      )}
    >
      <div
        role="region"
        aria-label={intl.formatMessage({ id: "irohCallStage.region", defaultMessage: "Peer-to-peer call" })}
        className="relative clip-corner-lg overflow-hidden bg-chrome-deep shadow-lg"
        data-testid="iroh-call-stage"
      >
        {hasVideo ? (
          <div className="flex flex-col gap-2 p-3" style={{ height: 420 }}>
            <div className="text-sm font-medium truncate">{callLabel}</div>
            {focused ? (
              <div className="flex-1 min-h-0">{focused.node(true)}</div>
            ) : (
              <div ref={gridRef} className="flex-1 min-h-0 overflow-hidden flex items-center justify-center">
                <div className="grid place-content-center gap-2" style={{ gridTemplateColumns: `repeat(${grid.cols}, ${grid.tileW}px)`, gridAutoRows: `${grid.tileH}px` }}>
                  {tiles.map((t) => (
                    <div key={t.key} style={{ width: grid.tileW, height: grid.tileH }}>
                      {t.node(false)}
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="flex justify-center">
              <IrohCallControls {...controls} large />
            </div>
          </div>
        ) : (
          <div className="relative flex flex-col items-center gap-3 px-4 pt-5 pb-3">
            <div className={cn("flex flex-wrap items-start justify-center", people.length <= 2 ? "gap-8" : "gap-4")}>
              {people.map((p) => (
                <HeroP2pPerson key={p.pubkey} pubkey={p.pubkey} self={p.self} speaking={p.speaking} muted={p.muted} streaming={p.sending.screen} size={size} theater={false} />
              ))}
            </div>
            <div className="text-center min-w-0 max-w-full font-semibold truncate text-base">{callLabel}</div>
            <IrohCallControls {...controls} large />
          </div>
        )}
      </div>
    </div>
  );
}
