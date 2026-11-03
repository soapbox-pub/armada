import { useNavigate } from "react-router-dom";

import {
  ArmadaWreck,
  ArmadaWreckKeyframes,
  WRECK_SCOPE,
  WreckSky,
  wreckQuake,
  wreckRise,
} from "@/components/brand/ArmadaWreck";
import { GameOverMenu } from "@/components/brand/GameOverMenu";
import { GameOverTitle } from "@/components/brand/GameOverTitle";
import { useWreckMusic } from "@/components/brand/useWreckMusic";
import { DOVE_LANDED, WreckDove } from "@/components/brand/WreckDove";
import { common } from "@/i18n/common";
import { FormattedMessage } from "@/i18n";

import type { ReactNode } from "react";

const SELF_HOST_GUIDE = "https://soapbox.pub/blog/how-to-self-host-armada";

/**
 * The wreck and its "Game over", shown in place of something the blocklist
 * takes down: a community (`CommunityBlocked`) or a user's profile
 * (`UserBanned`). `title` names what's unavailable, for screen readers only;
 * nothing about it is shown.
 */
export function GameOverScreen({ title }: { title: ReactNode }) {
  useWreckMusic();
  const navigate = useNavigate();

  return (
    <div
      className={`${WRECK_SCOPE} relative flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-4 overflow-hidden p-8 text-center`}
    >
      <ArmadaWreckKeyframes />
      <WreckSky />
      <div className="relative" style={wreckQuake}>
        <ArmadaWreck className="block h-auto w-[min(20rem,80vw)]" />
        <WreckDove />
      </div>
      <h1 className="relative" style={wreckRise(0)}>
        <GameOverTitle className="h-auto w-[min(24rem,80vw)]" />
        <span className="sr-only">{title}</span>
      </h1>
      <GameOverMenu
        delay={DOVE_LANDED + 0.5}
        items={[
          { label: <FormattedMessage {...common.continue} />, href: SELF_HOST_GUIDE },
          {
            label: <FormattedMessage id="gameOver.quit" defaultMessage="Quit" />,
            onSelect: () => navigate("/"),
          },
        ]}
      />
    </div>
  );
}
