import { createContext } from "react";

/** Members boosting the open Concord community (`lib/discoverBoost.ts`); empty elsewhere. */
export const BoostersContext = createContext<ReadonlySet<string>>(new Set());
