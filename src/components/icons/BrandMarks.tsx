import React from "react";

import { cn } from "@/lib/utils";

type MarkProps = React.SVGProps<SVGSVGElement>;

/**
 * LiveKit's symbol, from its brand kit (livekit.io/brand): the light- and dark-background
 * variants, picked by the theme. Bundled, so showing it fetches nothing.
 */
export function LiveKitMark({ className, ...props }: MarkProps) {
  const accent = "fill-[#002CF2] dark:fill-[#1FD5F9]";
  return (
    <svg viewBox="0 0 230 230" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="LiveKit" className={cn("shrink-0", className)} {...props}>
      <path className={accent} d="M137.884 92.4675H92.1167V138.235H137.884V92.4675Z" />
      <path className={accent} d="M183.651 46.718H137.884V92.4852H183.651V46.718Z" />
      <path className={accent} d="M183.651 138.234H137.884V184.002H183.651V138.234Z" />
      <path className={accent} d="M229.4 0.950928H183.633V46.7181H229.4V0.950928Z" />
      <path className={accent} d="M229.4 183.984H183.633V229.751H229.4V183.984Z" />
      <path
        className="fill-black dark:fill-white"
        d="M46.3673 183.984V138.235V92.4674V46.7181V0.950928H0.600098V46.7181V92.4674V138.235V183.984V229.751H46.3673H92.1165H137.884V183.984H92.1165H46.3673Z"
      />
    </svg>
  );
}

/** iroh's wordmark (n0-computer/iroh `.img/iroh_wordmark.svg`), which has no separate symbol. Bundled. */
export function IrohWordmark({ className, ...props }: MarkProps) {
  return (
    <svg viewBox="0 0 93.26 32" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="iroh" className={cn("shrink-0 fill-[#7c7cff]", className)} {...props}>
      <path d="m61.21,9.93h-7.74c-3.25,0-5.89,2.64-5.89,5.89v8.27c0,3.25,2.64,5.89,5.89,5.89h7.74c3.25,0,5.89-2.64,5.89-5.89v-8.27c0-3.25-2.64-5.89-5.89-5.89Zm2.93,14.79c0,.29-.11.57-.32.77l-1.21,1.21c-.2.2-.49.32-.77.32h-8.99c-.29,0-.57-.11-.77-.32l-1.21-1.21c-.21-.21-.32-.48-.32-.77v-9.53c0-.29.11-.57.32-.77l1.21-1.21c.21-.21.48-.32.77-.32h8.99c.29,0,.57.12.77.32l1.21,1.21c.21.21.32.48.32.77v9.53Z" />
      <path d="m90.26,14.29c-.29-1.14-.73-2.04-1.32-2.69-.59-.66-1.35-1.11-2.28-1.38-.93-.26-2.03-.39-3.28-.39-1.6,0-2.94.26-4.01.77-1.08.51-1.94,1.33-2.83,2.14h-.2V3.03c0-.33-.27-.6-.6-.6h-4.46v2.64h2.03v24.9h3.03v-13.25h0v-.18c0-.29.11-.57.32-.77,0,0,2.49-2.45,3.83-2.93.68-.24,1.37-.37,2.08-.37,1.02,0,1.86.14,2.51.43.65.29,1.17.71,1.55,1.28.38.56.63,1.27.76,2.1.13.84.2,1.82.2,2.95v10.74h3.11v-11.33c0-1.76-.14-3.21-.43-4.35Z" />
      <path d="m1.71,29.97v-2.64h8.16v-14.4H1.71v-2.64h11.27v17.03h8.21v2.64H1.71Z" />
      <circle cx="11.41" cy="4.65" r="2.44" />
      <path d="m42.74,14.29c-.11-.93-.31-1.72-.61-2.38-.3-.66-.72-1.15-1.26-1.49-.54-.34-1.25-.51-2.14-.51-1.52,0-2.83.29-3.93.87-1.1.58-2.1,1.27-2.99,2.08h-.2l-.55-2.22c-.05-.2-.23-.34-.43-.34h-7.01v2.64h5.31v14.4h-5.31v2.64h15.89v-2.64h-7.55v-10.63s0-.02,0-.03v-.45c0-.29.11-.57.32-.77,0,0,1.87-1.96,3.38-2.47.66-.22,1.39-.3,2.2-.3.87,0,1.46.39,1.79,1.17.33.78.49,2,.49,3.67l2.75-.04c0-1.18-.05-2.24-.16-3.17Z" />
    </svg>
  );
}
