/**
 * Service worker entry, bundled to `/sw.js` by the `serviceWorker()` plugin in
 * vite.config.ts. Everything it does is in `worker.ts` (event handling) and
 * `pushRuntime.ts` (opening, storing and presenting an event).
 */

import { verifyEvent } from "nostr-tools/pure";

import { installServiceWorker } from "@/sw/worker";
import { openConfig, preparePush, pushScope } from "@/sw/pushRuntime";

installServiceWorker({ preparePush, pushScope, openConfig, verifyEvent });
