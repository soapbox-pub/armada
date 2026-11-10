import { useContext, useEffect } from "react";

import { AppContext } from "@/contexts/AppContext";
import { floodPolicy, setActiveFloodPolicy, type FloodPolicy } from "@/concord/lib/floodPolicy";

/** The reader's flood tuning (Settings › Chat), interned so it is a stable dependency. */
export function useFloodPolicy(): FloodPolicy {
  const config = useContext(AppContext)?.config;
  const policy = floodPolicy(config?.spamSensitivity, config?.spamExemptBridged);
  // The remembered verdicts follow it too, for every fold that reads them.
  useEffect(() => setActiveFloodPolicy(policy), [policy]);
  return policy;
}
