import { Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * The hover-toolbar ⚡ button, shared by the timeline (ChatMessage) and the
 * thread panel (ThreadMessage): enabled while the author's profile may still
 * be loading, disabled (with a hint) once it has loaded without a lightning
 * address.
 */
export function ZapButton({ disabled, onOpen }: { disabled: boolean; onOpen: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Zap message"
          disabled={disabled}
          className="size-9 md:size-7 text-muted-foreground hover:text-amber-500 disabled:opacity-40"
          onClick={onOpen}
        >
          <Zap className="size-[18px] md:size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {disabled ? "No lightning address on their profile" : "Zap message"}
      </TooltipContent>
    </Tooltip>
  );
}
