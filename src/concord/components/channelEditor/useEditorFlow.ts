import { useRef, useState } from "react";

import { reviewMessages } from "@/concord/components/accessReview/reviewMessages";
import { rotateAgain, useApplyRun, type ApplyPhase } from "@/concord/components/accessReview/useApplyRun";
import { saveFailed, toastSaved, type EditorModel, type EditorReview } from "@/concord/components/channelEditor/useChannelEditor";
import { toast } from "@/hooks/useToast";
import { t } from "@/i18n";

/** What the editor asks about before doing it. */
export type EditorConfirm = "delete" | "rotate";

/** Save and what stands in front of it, shared by the sheet and the pane. */
export function useEditorFlow(model: EditorModel, onDone: (reason: "saved" | "removed") => void) {
  const [confirm, setConfirm] = useState<EditorConfirm | null>(null);
  // The review as it stood when Save was pressed: the fold moves under it once the write lands.
  const [review, setReview] = useState<EditorReview | null>(null);
  const run = useApplyRun();
  const showing = useRef(false);

  const save = async () => {
    if (await model.save()) onDone("saved");
  };
  const accept = async () => {
    const what = confirm;
    setConfirm(null);
    if (what === "delete") {
      if (await model.remove()) onDone("removed");
    } else if (what === "rotate") await model.rotateKey?.();
  };

  const hide = () => {
    showing.current = false;
    setReview(null);
    run.reset();
  };
  const settle = (outcome: "clean" | "unfinished") => {
    if (showing.current) {
      if (outcome === "unfinished") return;
      toastSaved();
      hide();
      onDone("saved");
      return;
    }
    // Closed as stuck: the outcome still has to be said somewhere.
    run.reset();
    if (outcome === "clean") toastSaved();
    else toast({ title: t(reviewMessages.applyUnfinished), variant: "destructive" });
  };
  const apply = async (plan: readonly ApplyPhase[], keep = false) => {
    settle(
      await run.start(
        plan,
        async (sink) => {
          // False is a save already running: nothing of this one was written.
          if (!(await model.save(sink))) throw new Error(saveFailed());
        },
        { keep },
      ),
    );
  };
  const unrotated = run.report?.rotationFailed.map((f) => f.channelIdHex) ?? [];
  const { retryRotation } = model;
  const retry =
    run.status !== "unfinished"
      ? undefined
      : run.failure === "write"
        ? () => void apply(model.review?.plan ?? ["save"], true)
        : unrotated.length > 0 && retryRotation
          ? () => void rotateAgain(run, unrotated, retryRotation).then(settle)
          : undefined;

  return {
    confirm,
    ask: (what: EditorConfirm) => {
      model.clearError();
      setConfirm(what);
    },
    dismiss: () => setConfirm(null),
    /** Who can read the scope is about to change, so it is shown first. */
    requestSave: () => {
      if (!model.review) return void save();
      model.clearError();
      run.reset();
      showing.current = true;
      setReview(model.review);
    },
    accept,
    review,
    run,
    /** The review can't be left: the change is being applied and no step has stalled. */
    locked: review !== null && run.status === "working" && !run.stuck,
    apply: () => {
      if (review && run.status === "review") void apply(review.plan);
    },
    /** Leaves the review. Once the change is saved the editor is done with, whatever its keys did. */
    leave: () => {
      const saved = run.status === "unfinished" && run.failure === "keys";
      hide();
      if (saved) onDone("saved");
    },
    retry,
  };
}

export type EditorFlow = ReturnType<typeof useEditorFlow>;
