import {
  useRef,
  useEffect,
  useCallback,
  forwardRef,
  useImperativeHandle,
  type IframeHTMLAttributes,
} from "react";
import { unzipSync } from "fflate";

import type {
  Webxdc as WebxdcAPI,
  ReceivedStatusUpdate,
  RealtimeListener,
} from "@webxdc/types/webxdc";

import { SandboxFrame, type SandboxFrameHandle } from "@/components/SandboxFrame";
import { useBlossomCandidates } from "@/hooks/useBlossomCandidates";
import { getMimeType, bytesToBase64, injectScriptTags } from "@/lib/sandbox";
import type { FileResponse } from "@/lib/sandbox";
import { decryptBuffer, fetchCapped, verifyPlaintextHash } from "@/lib/encryptedMedia";
import type { ImetaEncryption } from "@/lib/imeta";

export interface WebxdcProps
  extends Omit<IframeHTMLAttributes<HTMLIFrameElement>, "src" | "id"> {
  /** Unique session identifier — used as the sandbox subdomain. */
  id: string;
  xdc: Uint8Array | string;
  /** AES-GCM params for client-encrypted attachments (Concord); decrypted before unzip. */
  encryption?: ImetaEncryption;
  webxdc: WebxdcAPI<unknown>;
}

export interface WebxdcHandle {
  postMessage: (msg: Record<string, unknown>, transfer?: Transferable[]) => void;
  focus: () => void;
}

// The webxdc spec denies all internet access; enforced by CSP on every
// response (same-origin, inline, eval, wasm, data:, blob: allowed).

/** Well above the largest known xdc. */
const MAX_XDC_BYTES = 500 * 1024 * 1024;

const WEBXDC_CSP = [
  "default-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data: blob:",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

/** Resolve `xdc` to bytes, decrypting if needed; `candidates` includes Blossom mirrors. */
async function resolveXdc(
  xdc: Uint8Array | string,
  encryption: ImetaEncryption | undefined,
  candidates: readonly string[],
): Promise<Uint8Array> {
  if (typeof xdc === "string") {
    // Capped: the size is the sender's choice, and unzipping multiplies it.
    const raw = await fetchCapped(candidates.length ? candidates : [xdc], { maxBytes: MAX_XDC_BYTES });
    const bytes = encryption
      ? new Uint8Array(await decryptBuffer(raw, encryption.key, encryption.nonce))
      : new Uint8Array(raw);
    if (encryption) await verifyPlaintextHash(bytes, encryption.ox);
    return bytes;
  }
  return xdc;
}

/** Unzipped ceiling. The sizes are the archive's own claims, which fflate allocates by. */
const MAX_XDC_UNZIPPED_BYTES = 1024 * 1024 * 1024;
const MAX_XDC_FILES = 20_000;

function unzipXdc(bytes: Uint8Array): Map<string, Uint8Array> {
  let total = 0;
  let files = 0;
  const unzipped = unzipSync(bytes, {
    filter: (file) => {
      total += file.originalSize;
      if (++files > MAX_XDC_FILES || total > MAX_XDC_UNZIPPED_BYTES) {
        throw new Error("xdc archive expands too far");
      }
      return true;
    },
  });
  const fileMap = new Map<string, Uint8Array>();
  for (const [path, content] of Object.entries(unzipped)) {
    const normalised = path.replace(/^\/+/, "").replace(/\\/g, "/");
    if (normalised.endsWith("/")) continue;
    fileMap.set(normalised, content);
  }
  return fileMap;
}

/** The injected `window.webxdc` bridge, sending JSON-RPC via the sandbox frame. */
function generateWebxdcBridge(api: WebxdcAPI<unknown>): string {
  return `(function(){
  var nextId = 1;
  var pending = {};
  var updateListener = null;
  var updateListenerReady = null;
  var realtimeDataListener = null;
  var realtimeChannelId = null;

  function send(msg) {
    window.parent.postMessage(msg, "*");
  }

  function sendRequest(method, params) {
    var id = nextId++;
    return new Promise(function(resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
      send({ jsonrpc: "2.0", id: id, method: method, params: params });
    });
  }

  window.addEventListener("message", function(event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || typeof data !== "object" || data.jsonrpc !== "2.0") return;

    // JSON-RPC response
    if (data.id !== undefined && !data.method) {
      var p = pending[data.id];
      if (p) {
        delete pending[data.id];
        if (data.error) {
          p.reject(new Error(data.error.message));
        } else {
          p.resolve(data.result);
        }
      }
      return;
    }

    // Notifications from parent
    if (data.method && data.id === undefined) {
      switch (data.method) {
        case "webxdc.update":
          if (updateListener) updateListener(data.params.update);
          break;
        case "webxdc.realtimeChannel.data":
          if (realtimeDataListener) realtimeDataListener(new Uint8Array(data.params.data));
          break;
        case "webxdc.keyboard":
          var p2 = data.params;
          var evt = new KeyboardEvent(p2.type, {
            key: p2.key, code: p2.code, keyCode: p2.keyCode,
            bubbles: true, cancelable: true, composed: true
          });
          window.dispatchEvent(evt);
          document.dispatchEvent(new KeyboardEvent(p2.type, {
            key: p2.key, code: p2.code, keyCode: p2.keyCode,
            bubbles: true, cancelable: true
          }));
          break;
      }
    }
  });

  window.webxdc = {
    selfAddr: ${JSON.stringify(api.selfAddr)},
    selfName: ${JSON.stringify(api.selfName)},
    sendUpdateInterval: ${api.sendUpdateInterval},
    sendUpdateMaxSize: ${api.sendUpdateMaxSize},

    sendUpdate: function(update, descr) {
      sendRequest("webxdc.sendUpdate", { update: update, descr: descr });
    },

    setUpdateListener: function(cb, serial) {
      updateListener = cb;
      return new Promise(function(resolve) {
        updateListenerReady = resolve;
        sendRequest("webxdc.setUpdateListener", { serial: serial || 0 }).then(function() {
          if (updateListenerReady) { updateListenerReady(); updateListenerReady = null; }
        });
      });
    },

    getAllUpdates: function() {
      return sendRequest("webxdc.getAllUpdates");
    },

    sendToChat: function(message) {
      return sendRequest("webxdc.sendToChat", { message: message });
    },

    importFiles: function(filter) {
      return sendRequest("webxdc.importFiles", { filter: filter || {} });
    },

    joinRealtimeChannel: function() {
      if (realtimeChannelId) throw new Error("Already joined a realtime channel. Leave first.");
      var channelIdPromise = sendRequest("webxdc.joinRealtimeChannel");
      var joined = true;
      channelIdPromise.then(function(r) { realtimeChannelId = r.channelId; });
      return {
        setListener: function(cb) {
          if (!joined) throw new Error("Channel has been left.");
          realtimeDataListener = cb;
        },
        send: function(data) {
          if (!joined) throw new Error("Channel has been left.");
          channelIdPromise.then(function(r) {
            sendRequest("webxdc.realtimeChannel.send", { channelId: r.channelId, data: Array.from(data) });
          });
        },
        leave: function() {
          if (!joined) return;
          joined = false;
          realtimeDataListener = null;
          channelIdPromise.then(function(r) {
            sendRequest("webxdc.realtimeChannel.leave", { channelId: r.channelId });
            realtimeChannelId = null;
          });
        }
      };
    }
  };
})();`;
}

/** Webxdc app in a sandboxed iframe: serves the unzipped `.xdc`, injects the bridge, proxies `webxdc.*` RPC. */
export const Webxdc = forwardRef<WebxdcHandle, WebxdcProps>(function Webxdc(
  { id, xdc, encryption, webxdc, ...iframeProps },
  ref,
) {
  const sandboxRef = useRef<SandboxFrameHandle>(null);

  const webxdcRef = useRef(webxdc);
  const xdcRef = useRef(xdc);
  const encryptionRef = useRef(encryption);
  // Fetched directly, not via the image proxy: this is a deliberate open.
  const candidates = useBlossomCandidates(typeof xdc === "string" ? xdc : undefined);
  const candidatesRef = useRef(candidates);
  useEffect(() => {
    webxdcRef.current = webxdc;
  }, [webxdc]);
  useEffect(() => {
    xdcRef.current = xdc;
  }, [xdc]);
  useEffect(() => {
    encryptionRef.current = encryption;
  }, [encryption]);
  useEffect(() => {
    candidatesRef.current = candidates;
  }, [candidates]);

  const fileMapRef = useRef<Map<string, Uint8Array> | null>(null);
  const bridgeScriptRef = useRef<string>("");
  // The loader re-sends `ready` every 500ms until `init`; cache the promise so
  // a slow download isn't restarted in parallel on every retry.
  const loadPromiseRef = useRef<Promise<void> | null>(null);

  const realtimeChannels = useRef<Map<string, RealtimeListener>>(new Map());

  useImperativeHandle(
    ref,
    () => ({
      postMessage: (msg: Record<string, unknown>, transfer?: Transferable[]) => {
        sandboxRef.current?.postMessage(msg, transfer);
      },
      focus: () => {
        sandboxRef.current?.focus();
      },
    }),
    [],
  );

  useEffect(() => {
    const channels = realtimeChannels.current;
    return () => {
      for (const ch of channels.values()) ch.leave();
      channels.clear();
    };
  }, []);

  const onReady = useCallback(() => {
    loadPromiseRef.current ??= (async () => {
      try {
        const bytes = await resolveXdc(xdcRef.current, encryptionRef.current, candidatesRef.current);
        fileMapRef.current = unzipXdc(bytes);
        bridgeScriptRef.current = generateWebxdcBridge(webxdcRef.current);
      } catch (err) {
        console.error("[Webxdc] Failed to initialise:", err);
        // Allow a later `ready` to retry after a failure.
        loadPromiseRef.current = null;
      }
    })();
    return loadPromiseRef.current;
  }, []);

  const resolveFile = useCallback(async (pathname: string): Promise<FileResponse | null> => {
    const fileMap = fileMapRef.current;
    if (!fileMap) {
      return {
        status: 503,
        contentType: "text/plain",
        body: new TextEncoder().encode("Archive not loaded"),
      };
    }

    const filePath =
      pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));

    const fileBytes = fileMap.get(filePath);
    if (!fileBytes) return null;

    return { status: 200, contentType: getMimeType(filePath), body: fileBytes };
  }, []);

  // The bridge embeds runtime values (selfAddr), so serve /webxdc.js ourselves.
  const resolveFileWithBridge = useCallback(
    async (pathname: string): Promise<FileResponse | null> => {
      if (pathname === "/webxdc.js") {
        return {
          status: 200,
          contentType: "application/javascript",
          body: new TextEncoder().encode(bridgeScriptRef.current),
        };
      }

      const file = await resolveFile(pathname);
      if (!file) return null;

      if (file.contentType.includes("text/html")) {
        const html = new TextDecoder().decode(file.body);
        const injected = injectScriptTags(html, ["/webxdc.js"]);
        return { ...file, body: new TextEncoder().encode(injected) };
      }

      return file;
    },
    [resolveFile],
  );

  const onRpc = useCallback(
    async (
      method: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      params: any,
      post: (msg: Record<string, unknown>) => void,
    ): Promise<unknown> => {
      const api = webxdcRef.current;

      switch (method) {
        case "webxdc.sendUpdate": {
          api.sendUpdate(params.update, "");
          return null;
        }

        case "webxdc.setUpdateListener": {
          const serial: number = params.serial ?? 0;
          await api.setUpdateListener((update: ReceivedStatusUpdate<unknown>) => {
            post({ jsonrpc: "2.0", method: "webxdc.update", params: { update } });
          }, serial);
          return null;
        }

        case "webxdc.getAllUpdates": {
          return await api.getAllUpdates();
        }

        case "webxdc.sendToChat": {
          await api.sendToChat(params.message);
          return null;
        }

        case "webxdc.importFiles": {
          const files = await api.importFiles(params.filter ?? {});
          return await Promise.all(
            files.map(async (f) => ({
              name: f.name,
              type: f.type,
              data: bytesToBase64(new Uint8Array(await f.arrayBuffer())),
            })),
          );
        }

        case "webxdc.joinRealtimeChannel": {
          if (!api.joinRealtimeChannel) {
            throw new Error("Realtime channels are not supported");
          }
          const rt = api.joinRealtimeChannel();
          const channelId = crypto.randomUUID();

          rt.setListener((data: Uint8Array) => {
            post({
              jsonrpc: "2.0",
              method: "webxdc.realtimeChannel.data",
              params: { channelId, data: Array.from(data) },
            });
          });

          realtimeChannels.current.set(channelId, rt);
          return { channelId };
        }

        case "webxdc.realtimeChannel.send": {
          const ch = realtimeChannels.current.get(params.channelId);
          if (ch) ch.send(new Uint8Array(params.data));
          return null;
        }

        case "webxdc.realtimeChannel.leave": {
          const ch = realtimeChannels.current.get(params.channelId);
          if (ch) {
            ch.leave();
            realtimeChannels.current.delete(params.channelId);
          }
          return null;
        }

        default:
          throw new Error(`Method not found: ${method}`);
      }
    },
    [],
  );

  return (
    <SandboxFrame
      ref={sandboxRef}
      id={id}
      resolveFile={resolveFileWithBridge}
      onRpc={onRpc}
      csp={WEBXDC_CSP}
      onReady={onReady}
      {...iframeProps}
    />
  );
});

export default Webxdc;
