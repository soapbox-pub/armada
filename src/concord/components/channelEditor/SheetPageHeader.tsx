import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";

import { SHEET_BACK, SHEET_TITLE } from "@/concord/components/channelEditor/editorStyles";
import { common, useIntl } from "@/i18n";
import { cn } from "@/lib/utils";

/** The header of a page inside a sheet: back, what the page is, and what it is about. */
export function SheetPageHeader({ onBack, title, context }: { onBack: () => void; title: ReactNode; context?: ReactNode }) {
  const intl = useIntl();
  return (
    // The back button sits on the rows' tile column, so the title starts where their labels do.
    <div className="flex shrink-0 items-center gap-3 px-5 pb-1">
      <button type="button" aria-label={intl.formatMessage(common.back)} className={SHEET_BACK} onClick={onBack}>
        <ChevronLeft className="size-5" />
      </button>
      <div className="flex min-w-0 items-baseline gap-2">
        <h2 className={cn("min-w-0", SHEET_TITLE)}>{title}</h2>
        {context && <span className="truncate text-sm text-muted-foreground">{context}</span>}
      </div>
    </div>
  );
}
