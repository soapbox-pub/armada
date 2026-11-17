import { AccessReviewPanel, type AccessReviewProps } from "@/concord/components/accessReview/AccessReviewPanel";
import { reviewMessages as m } from "@/concord/components/accessReview/reviewMessages";
import { ChromeDialogContent, Dialog } from "@/components/ui/dialog";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { useIsTouch } from "@/hooks/useIsMobile";
import { useIntl } from "@/i18n";

/**
 * {@link AccessReviewPanel} as its own overlay: a sheet on touch, a chrome dialog
 * otherwise. It can't be dismissed while the change is being applied, unless a
 * step has sat long enough to be called stuck.
 */
export function AccessReviewDialog(props: Omit<AccessReviewProps, "variant">) {
  const intl = useIntl();
  const touch = useIsTouch();
  const { run, onCancel, onClose } = props;
  const locked = run.status === "working" && !run.stuck;
  const leave = () => {
    if (locked) return;
    if (run.status === "review") onCancel();
    else onClose();
  };
  const title = intl.formatMessage(run.status === "working" ? m.applyingTitle : run.status === "unfinished" ? m.unfinishedTitle : m.title);
  const hold = (e: { preventDefault: () => void }) => {
    if (locked) e.preventDefault();
  };

  if (touch) {
    return (
      <Drawer open dismissible={!locked} onOpenChange={(open) => !open && leave()}>
        <DrawerContent
          className="z-[260] max-h-[85dvh]"
          overlayClassName="z-[260]"
          aria-describedby={undefined}
          onPointerDownOutside={hold}
          onInteractOutside={hold}
          onEscapeKeyDown={hold}
        >
          <DrawerTitle className="sr-only">{title}</DrawerTitle>
          <AccessReviewPanel {...props} variant="sheet" />
        </DrawerContent>
      </Drawer>
    );
  }
  return (
    <Dialog open onOpenChange={(open) => !open && leave()}>
      <ChromeDialogContent
        title={title}
        className="sm:max-w-md focus:outline-none"
        contentClassName="flex max-h-[85dvh] flex-col"
        hideClose
        aria-describedby={undefined}
        onPointerDownOutside={hold}
        onInteractOutside={hold}
        onEscapeKeyDown={hold}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement | null)?.focus();
        }}
      >
        <AccessReviewPanel {...props} variant="dialog" />
      </ChromeDialogContent>
    </Dialog>
  );
}
