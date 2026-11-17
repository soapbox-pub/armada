import { useState } from "react";

import type { EditorModel } from "@/concord/components/channelEditor/useChannelEditor";

/** What the editor asks about before doing it. */
export type EditorConfirm = "delete" | "rotate" | "privacy";

/** Save and the confirmations in front of it, shared by the sheet and the pane. */
export function useEditorFlow(model: EditorModel, onDone: (reason: "saved" | "removed") => void) {
  const [confirm, setConfirm] = useState<EditorConfirm | null>(null);
  const privacy = model.steps.some((s) => s.kind === "private" || s.kind === "public");

  const save = async () => {
    if (await model.save()) onDone("saved");
  };
  const accept = async () => {
    const what = confirm;
    setConfirm(null);
    if (what === "privacy") await save();
    else if (what === "delete") {
      if (await model.remove()) onDone("removed");
    } else if (what === "rotate") await model.rotateKey?.();
  };

  return {
    confirm,
    ask: (what: EditorConfirm) => {
      model.clearError();
      setConfirm(what);
    },
    dismiss: () => setConfirm(null),
    /** Who can read the Channel is about to change, so it is spelled out first. */
    requestSave: () => (privacy ? setConfirm("privacy") : void save()),
    accept,
  };
}

export type EditorFlow = ReturnType<typeof useEditorFlow>;
