import {
  useRef,
  useEffect,
  useCallback,
  useMemo,
  forwardRef,
  useImperativeHandle,
  type IframeHTMLAttributes,
} from "react";

import { SANDBOX_DOMAIN } from "@/lib/platform";
import { bytesToBase64, utf8ToBase64, injectScriptTags } from "@/lib/sandbox";
import type {
  FileResponse,
  InjectedScript,
  JsonRpcResponse,
  SerialisedRequest,
} from "@/lib/sandbox";

export interface SandboxFrameProps
  extends Omit<IframeHTMLAttributes<HTMLIFrameElement>, "src" | "id" | "sandbox"> {
  /** HMAC-derived subdomain identifier. */
  id: string;
  /** Resolve a pathname to file content, or `null` for a 404. */
  resolveFile: (pathname: string) => Promise<FileResponse | null>;
  /** Handle non-fetch JSON-RPC methods (e.g. `webxdc.*`); `post` pushes messages into the sandbox. */
  onRpc?: (
    method: string,
    params: unknown,
    post: (msg: Record<string, unknown>) => void,
  ) => Promise<unknown>;
  /** Served at `path` and prepended as a `<script>` into every HTML response's `<head>`. */
  injectedScripts?: InjectedScript[];
  csp?: string;
  /** Called on `ready`; `init` is deferred until it resolves so fetches don't arrive early. */
  onReady?: () => void | Promise<void>;
}

export interface SandboxFrameHandle {
  postMessage: (msg: Record<string, unknown>, transfer?: Transferable[]) => void;
  focus: () => void;
}

async function handleFetchRequest(
  pathname: string,
  resolveFile: (pathname: string) => Promise<FileResponse | null>,
  scripts: InjectedScript[],
  activeCsp: string | undefined,
  respond: (result: Record<string, unknown>) => void,
  respondError: (code: number, message: string) => void,
): Promise<void> {
  const virtualScript = scripts.find(
    (s) => pathname === `/${s.path}` || pathname === s.path,
  );
  if (virtualScript) {
    const headers: Record<string, string> = {
      "Content-Type": "application/javascript",
      "Cache-Control": "no-cache",
    };
    if (activeCsp) headers["Content-Security-Policy"] = activeCsp;

    respond({
      status: 200,
      statusText: "OK",
      headers,
      body: utf8ToBase64(virtualScript.content),
    });
    return;
  }

  try {
    const file = await resolveFile(pathname);

    if (!file) {
      const headers: Record<string, string> = { "Content-Type": "text/plain" };
      if (activeCsp) headers["Content-Security-Policy"] = activeCsp;

      respond({
        status: 404,
        statusText: "Not Found",
        headers,
        body: utf8ToBase64("Not Found"),
      });
      return;
    }

    let bodyBase64: string;
    if (file.contentType === "text/html" && scripts.length > 0) {
      const html = new TextDecoder().decode(file.body);
      const injected = injectScriptTags(
        html,
        scripts.map((s) => `/${s.path}`),
      );
      bodyBase64 = utf8ToBase64(injected);
    } else {
      bodyBase64 = bytesToBase64(file.body);
    }

    const headers: Record<string, string> = {
      "Content-Type": file.contentType,
      "Cache-Control": "no-cache",
    };
    if (activeCsp) headers["Content-Security-Policy"] = activeCsp;
    if (file.contentType !== "text/html") {
      headers["Content-Length"] = String(file.body.byteLength);
    }

    respond({
      status: file.status,
      statusText: "OK",
      headers,
      body: bodyBase64,
    });
  } catch (err) {
    respondError(-32002, String(err));
  }
}

/**
 * Permissions-policy grant for sandbox iframes: what a game needs, nothing
 * that captures or locates the viewer. A delegated feature rides the app
 * origin's grant with no prompt (and Capacitor's iOS delegate grants capture
 * outright), so camera, microphone, geolocation and display-capture would hand
 * sender-written code the viewer's voice-call permissions. Also omits payment,
 * WebAuthn, OTP, FedCM and `clipboard-write`.
 */
export const SANDBOX_ALLOW = [
  "accelerometer",
  "autoplay",
  "encrypted-media",
  "fullscreen",
  "gamepad",
  "gyroscope",
  "keyboard-map",
  "magnetometer",
  "picture-in-picture",
  "pointer-lock",
  "screen-wake-lock",
  "web-share",
  "xr-spatial-tracking",
].join("; ");

/** Popups stay sandboxed: an escaped one is an unsandboxed page the Mini App's author chose. */
export const SANDBOX_FLAGS =
  "allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock";

/**
 * Sandboxed frame on a unique subdomain (`<id>.<SANDBOX_DOMAIN>`) implementing
 * the iframe.diy handshake + fetch proxy. Same on web and Capacitor.
 */
export const SandboxFrame = forwardRef<SandboxFrameHandle, SandboxFrameProps>(
  function SandboxFrame(
    { id, resolveFile, onRpc, injectedScripts, csp, onReady, ...iframeProps },
    ref,
  ) {
    const iframeRef = useRef<HTMLIFrameElement>(null);

    const origin = useMemo(() => `https://${id}.${SANDBOX_DOMAIN}`, [id]);

    const resolveFileRef = useRef(resolveFile);
    const onRpcRef = useRef(onRpc);
    const injectedScriptsRef = useRef(injectedScripts);
    const cspRef = useRef(csp);
    const onReadyRef = useRef(onReady);

    useEffect(() => {
      resolveFileRef.current = resolveFile;
    }, [resolveFile]);
    useEffect(() => {
      onRpcRef.current = onRpc;
    }, [onRpc]);
    useEffect(() => {
      injectedScriptsRef.current = injectedScripts;
    }, [injectedScripts]);
    useEffect(() => {
      cspRef.current = csp;
    }, [csp]);
    useEffect(() => {
      onReadyRef.current = onReady;
    }, [onReady]);

    const post = useCallback(
      (msg: Record<string, unknown>, transfer?: Transferable[]) => {
        iframeRef.current?.contentWindow?.postMessage(msg, origin, transfer ?? []);
      },
      [origin],
    );

    useImperativeHandle(
      ref,
      () => ({
        postMessage: (msg: Record<string, unknown>, transfer?: Transferable[]) => {
          iframeRef.current?.contentWindow?.postMessage(msg, origin, transfer ?? []);
        },
        focus: () => {
          iframeRef.current?.focus();
        },
      }),
      [origin],
    );

    useEffect(() => {
      function onMessage(event: MessageEvent) {
        if (event.origin !== origin) return;
        if (event.source !== iframeRef.current?.contentWindow) return;

        const msg = event.data;
        if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return;

        if (msg.method === "ready" && msg.id === undefined) {
          handleReady();
          return;
        }

        if (msg.id !== undefined && msg.method) {
          if (msg.method === "fetch") {
            handleFetch(msg.id, msg.params);
          } else if (onRpcRef.current) {
            handleRpc(msg.id, msg.method, msg.params ?? {});
          }
        }
      }

      async function handleReady() {
        try {
          await onReadyRef.current?.();
        } catch (err) {
          console.error("[SandboxFrame] onReady failed:", err);
        }
        post({ jsonrpc: "2.0", method: "init", params: { version: 1 } });
      }

      async function handleFetch(
        id: string | number,
        params: { request?: SerialisedRequest },
      ) {
        const reqUrl = params?.request?.url;
        if (!reqUrl) {
          post({ jsonrpc: "2.0", id, error: { code: -32001, message: "Invalid request" } });
          return;
        }

        let pathname: string;
        try {
          const url = new URL(reqUrl);
          if (url.origin !== origin) {
            post({ jsonrpc: "2.0", id, error: { code: -32003, message: "Origin mismatch" } });
            return;
          }
          pathname = url.pathname;
        } catch {
          post({ jsonrpc: "2.0", id, error: { code: -32003, message: "Invalid URL" } });
          return;
        }

        await handleFetchRequest(
          pathname,
          resolveFileRef.current,
          injectedScriptsRef.current ?? [],
          cspRef.current,
          (result) => post({ jsonrpc: "2.0", id, result }),
          (code, message) => post({ jsonrpc: "2.0", id, error: { code, message } }),
        );
      }

      async function handleRpc(id: string | number, method: string, params: unknown) {
        try {
          const result = await onRpcRef.current!(method, params, post);
          post({ jsonrpc: "2.0", id, result: result ?? null } satisfies JsonRpcResponse);
        } catch (err) {
          post({
            jsonrpc: "2.0",
            id,
            error: { code: -1, message: String(err) },
          } satisfies JsonRpcResponse);
        }
      }

      window.addEventListener("message", onMessage);
      return () => window.removeEventListener("message", onMessage);
    }, [origin, post]);

    return (
      <iframe
        ref={iframeRef}
        src={`${origin}/`}
        allow={SANDBOX_ALLOW}
        // Defense-in-depth on top of subdomain isolation. allow-same-origin is
        // needed for storage and the iframe.diy Service Worker; allow-top-navigation
        // is omitted to prevent phishing redirects.
        sandbox={SANDBOX_FLAGS}
        {...iframeProps}
      />
    );
  },
);

export default SandboxFrame;
