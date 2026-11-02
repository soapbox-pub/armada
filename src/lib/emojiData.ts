import { useEffect, useState } from "react";

/**
 * emoji-mart's dataset, loaded on first use. It is ~470 KB of source and a
 * large object graph once parsed, and every composer only needs it once the
 * user types a `:`, so nothing imports it statically on the way to a chat.
 */
export interface EmojiMartData {
  emojis: Record<string, { name: string; keywords?: string[]; skins?: Array<{ native?: string }> }>;
  aliases: Record<string, string>;
}

let loaded: EmojiMartData | undefined;
let loading: Promise<EmojiMartData> | undefined;

/** The dataset if it has loaded, else undefined (call {@link loadEmojiData}). */
export function emojiData(): EmojiMartData | undefined {
  return loaded;
}

export function loadEmojiData(): Promise<EmojiMartData> {
  loading ??= import("@emoji-mart/data").then((m) => {
    loaded = m.default as unknown as EmojiMartData;
    return loaded;
  });
  return loading;
}

/** The dataset once `wanted` has been true and it has loaded. */
export function useEmojiData(wanted: boolean): EmojiMartData | undefined {
  const [data, setData] = useState(loaded);
  useEffect(() => {
    if (!wanted || data) return;
    let live = true;
    void loadEmojiData().then((d) => {
      if (live) setData(d);
    });
    return () => {
      live = false;
    };
  }, [wanted, data]);
  return data;
}
