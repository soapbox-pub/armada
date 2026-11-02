import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { decryptBuffer, fetchCapped, verifyPlaintextHash } from "@/lib/encryptedMedia";
import { parseModel, stageModel } from "@/lib/modelRenderer";
import { FormattedMessage, useIntl } from "@/i18n";

import type { ImetaEncryption } from "@/lib/imeta";
import type { ModelFormat } from "@/lib/mediaUrls";
import { reducedMotion } from "@/lib/reducedMotion";

interface ModelViewerProps {
  /** Same-blob mirrors in order ({@link useBlossomCandidates}); fetched directly on the viewer's tap. */
  candidates: readonly string[];
  format: ModelFormat;
  /** Present when the blob is ciphertext. */
  encryption?: ImetaEncryption;
}

/**
 * Largest model downloaded, enforced while reading (`size` is the sender's
 * word). Parsing much more than this can take a phone's WebView down.
 */
const MAX_MODEL_BYTES = 200 * 1024 * 1024;

/** Seconds per full turn of the idle spin. */
const AUTO_ROTATE_PERIOD_S = 40;

/** Seconds for the idle spin to come up to speed after the model returns home. */
const SPIN_FADE_IN_S = 2;

/** Time constant of a flick's slowdown, in seconds: long, so it coasts. */
const COAST_DECAY_S = 1.8;

/** Fastest a flick sends the model, in radians per second. */
const MAX_FLICK_SPEED = 6 * Math.PI;

/** How long the model is left alone before it goes home and spins again. */
const IDLE_RETURN_MS = 5_000;

/**
 * Interactive 3D view of a model attachment: drag or flick to turn it, pinch
 * or scroll to zoom, double-tap to put it back. Spins slowly on its own and
 * returns to that a few seconds after it's let go. Lazy-loaded — it pulls in
 * three's loaders — and mounted only on a tap, since models run large.
 */
export default function ModelViewer({ candidates, format, encryption }: ModelViewerProps) {
  const intl = useIntl();
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [progress, setProgress] = useState<number>();

  // Keyed on content: the candidate list and the encryption object are rebuilt
  // by parents, and a reload here refetches tens of megabytes.
  const candidatesKey = candidates.join("\n");
  const { algorithm = "", key = "", nonce = "", ox } = encryption ?? {};

  useEffect(() => {
    const container = containerRef.current;
    const sources = candidatesKey ? candidatesKey.split("\n") : [];
    if (!container || sources.length === 0) {
      setStatus("error");
      return;
    }

    const abort = new AbortController();
    let disposed = false;
    let cleanup: (() => void) | undefined;
    setStatus("loading");
    setProgress(undefined);

    (async () => {
      const raw = await fetchCapped(sources, {
        signal: abort.signal,
        maxBytes: MAX_MODEL_BYTES + (algorithm ? 16 : 0),
        onProgress: (fraction) => {
          if (!disposed) setProgress(fraction);
        },
      });
      let data = raw;
      if (algorithm) {
        data = await decryptBuffer(raw, key, nonce);
        // A swapped blob fails closed.
        await verifyPlaintextHash(new Uint8Array(data), ox);
      }
      if (disposed) return;
      const parsed = await parseModel(data, format);
      if (disposed) {
        parsed.release();
        return;
      }

      const width = container.clientWidth || 400;
      const height = container.clientHeight || 300;
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(width, height);
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.domElement.className = "block size-full touch-none";
      container.appendChild(renderer.domElement);

      const stage = stageModel(parsed.model, format, renderer, width / height);
      const canvas = renderer.domElement;

      // Zoom only: orbit controls pin the world's up axis, so once a model is
      // tipped toward the viewer a sideways drag spins it in place. Turning is
      // done below, on the model itself.
      const controls = new OrbitControls(stage.camera, canvas);
      controls.enableRotate = false;
      controls.enablePan = false;
      controls.enableDamping = true;
      controls.minDistance = stage.radius * 0.2;
      controls.maxDistance = stage.radius * 20;

      // A drag turns the model as if in hand: sideways about the true vertical,
      // so an upright model stays upright, and up and down about the screen's
      // horizontal. Not the screen's vertical — the camera looks down slightly,
      // so that axis leans back and would tilt the model.
      const worldUp = new THREE.Vector3(0, 1, 0);
      const screenRight = new THREE.Vector3();
      const turn = new THREE.Quaternion();
      const rotateBy = (dx: number, dy: number) => {
        stage.camera.updateMatrixWorld();
        screenRight.setFromMatrixColumn(stage.camera.matrixWorld, 0);
        stage.pivot.quaternion
          .premultiply(turn.setFromAxisAngle(worldUp, dx))
          .premultiply(turn.setFromAxisAngle(screenRight, dy))
          .normalize();
      };

      const reduceMotion = reducedMotion();

      // `spin`: the idle turntable. `free`: in hand, or coasting from a flick.
      // `returning`: easing home after being left alone.
      let mode: "spin" | "free" | "returning" = "spin";
      let spinLevel = 1;
      // Radians per second, carried on after a flick.
      const velocity = { x: 0, y: 0, at: 0 };
      let lastActivity = performance.now();
      const pointers = new Map<number, { x: number; y: number }>();

      // Each drag turns about one axis, picked from its first few pixels: no
      // drag is straight, and turning about both tips the model askew.
      const drag = { startX: 0, startY: 0, axis: undefined as "x" | "y" | undefined };

      const homeCamera = stage.camera.position.clone();
      const homeTurn = new THREE.Quaternion();
      const lastTap = { at: -Infinity, x: 0, y: 0 };
      const goHome = () => {
        velocity.x = velocity.y = 0;
        mode = "returning";
      };
      const takeHold = () => {
        mode = "free";
        lastActivity = performance.now();
      };

      const onPointerDown = (e: PointerEvent) => {
        takeHold();
        velocity.x = velocity.y = 0;
        velocity.at = e.timeStamp;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        canvas.setPointerCapture(e.pointerId);
        drag.startX = e.clientX;
        drag.startY = e.clientY;
        drag.axis = undefined;
      };
      const onPointerMove = (e: PointerEvent) => {
        const last = pointers.get(e.pointerId);
        if (!last) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        lastActivity = performance.now();
        // Two fingers are a pinch, which the zoom controls handle.
        if (pointers.size !== 1) return;
        if (!drag.axis) {
          const ox = e.clientX - drag.startX;
          const oy = e.clientY - drag.startY;
          if (Math.hypot(ox, oy) < 8) return;
          drag.axis = Math.abs(ox) >= Math.abs(oy) ? "x" : "y";
        }
        // Half a turn per width dragged.
        const radiansPerPixel = Math.PI / (canvas.clientWidth || 400);
        const dx = drag.axis === "x" ? (e.clientX - last.x) * radiansPerPixel : 0;
        const dy = drag.axis === "y" ? (e.clientY - last.y) * radiansPerPixel : 0;
        rotateBy(dx, dy);

        // Smoothed over the last few events, so a flick carries on at release speed.
        const dt = Math.max(0.004, (e.timeStamp - velocity.at) / 1000);
        velocity.x = velocity.x * 0.3 + (dx / dt) * 0.7;
        velocity.y = velocity.y * 0.3 + (dy / dt) * 0.7;
        velocity.at = e.timeStamp;
      };
      const onPointerUp = (e: PointerEvent) => {
        pointers.delete(e.pointerId);
        lastActivity = performance.now();
        // Only a release while still moving flings; not after a pause or mid-pinch.
        if (pointers.size > 0 || e.timeStamp - velocity.at > 80) {
          velocity.x = velocity.y = 0;
        } else {
          const speed = Math.hypot(velocity.x, velocity.y);
          if (speed > MAX_FLICK_SPEED) {
            velocity.x *= MAX_FLICK_SPEED / speed;
            velocity.y *= MAX_FLICK_SPEED / speed;
          }
        }

        // A double tap (releases that never became drags) sends it home.
        if (e.type !== "pointerup" || drag.axis || pointers.size > 0) return;
        if (e.timeStamp - lastTap.at < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
          goHome();
          lastTap.at = -Infinity;
        } else {
          Object.assign(lastTap, { at: e.timeStamp, x: e.clientX, y: e.clientY });
        }
      };
      canvas.addEventListener("pointerdown", onPointerDown);
      canvas.addEventListener("pointermove", onPointerMove);
      canvas.addEventListener("pointerup", onPointerUp);
      canvas.addEventListener("pointercancel", onPointerUp);
      controls.addEventListener("start", takeHold);
      // Not `takeHold`: the controls end on every release, a double tap's
      // included, which would cancel the trip home it just started.
      const onControlsEnd = () => { lastActivity = performance.now(); };
      controls.addEventListener("end", onControlsEnd);

      const clock = new THREE.Clock();

      renderer.setAnimationLoop(() => {
        // Clamped so a frame after the tab was hidden doesn't jump.
        const delta = Math.min(clock.getDelta(), 0.1);

        if (mode === "returning") {
          const t = 1 - Math.exp(-delta * 3);
          stage.pivot.quaternion.slerp(homeTurn, t);
          stage.camera.position.lerp(homeCamera, t);
          if (stage.pivot.quaternion.angleTo(homeTurn) < 1e-3 && stage.camera.position.distanceTo(homeCamera) < stage.radius * 1e-3) {
            stage.pivot.quaternion.copy(homeTurn);
            stage.camera.position.copy(homeCamera);
            mode = "spin";
            spinLevel = 0;
          }
        } else if (mode === "spin") {
          if (!reduceMotion) {
            spinLevel = Math.min(1, spinLevel + delta / SPIN_FADE_IN_S);
            stage.pivot.rotateOnWorldAxis(worldUp, (spinLevel * delta * 2 * Math.PI) / AUTO_ROTATE_PERIOD_S);
          }
        } else if (pointers.size === 0) {
          if (velocity.x || velocity.y) {
            rotateBy(velocity.x * delta, velocity.y * delta);
            const decay = Math.exp(-delta / COAST_DECAY_S);
            velocity.x *= decay;
            velocity.y *= decay;
            if (Math.hypot(velocity.x, velocity.y) < 0.01) velocity.x = velocity.y = 0;
          }
          // Left alone and no faster than twice the idle spin: go home.
          const idle = performance.now() - lastActivity > IDLE_RETURN_MS;
          if (idle && Math.hypot(velocity.x, velocity.y) < (2 * Math.PI) / AUTO_ROTATE_PERIOD_S * 2) goHome();
        }

        controls.update();
        renderer.render(stage.scene, stage.camera);
      });

      const resize = new ResizeObserver(() => {
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (!w || !h) return;
        stage.camera.aspect = w / h;
        stage.camera.updateProjectionMatrix();
        renderer.setSize(w, h);
      });
      resize.observe(container);

      cleanup = () => {
        resize.disconnect();
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointermove", onPointerMove);
        canvas.removeEventListener("pointerup", onPointerUp);
        canvas.removeEventListener("pointercancel", onPointerUp);
        controls.removeEventListener("start", takeHold);
        controls.removeEventListener("end", onControlsEnd);
        renderer.setAnimationLoop(null);
        controls.dispose();
        stage.dispose();
        renderer.dispose();
        renderer.forceContextLoss();
        renderer.domElement.remove();
        parsed.release();
      };
      setStatus("ready");
    })().catch(() => {
      if (!disposed) setStatus("error");
    });

    return () => {
      disposed = true;
      abort.abort();
      cleanup?.();
    };
  }, [candidatesKey, format, algorithm, key, nonce, ox]);

  return (
    <div
      ref={containerRef}
      className="relative aspect-[4/3] w-full bg-gradient-to-b from-muted/40 to-muted"
      onClick={(e) => e.stopPropagation()}
    >
      {status === "loading" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2" role="status" aria-label={intl.formatMessage({ id: "modelViewer.loading", defaultMessage: "Loading model" })}>
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
          {progress !== undefined && progress < 1 && (
            <span className="text-xs text-muted-foreground tabular-nums">{Math.round(progress * 100)}%</span>
          )}
        </div>
      )}
      {status === "error" && (
        <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-muted-foreground">
          <FormattedMessage id="modelViewer.error" defaultMessage="This model couldn't be displayed." />
        </div>
      )}
    </div>
  );
}
