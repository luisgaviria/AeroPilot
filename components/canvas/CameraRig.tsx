"use client";

import { useRef, useEffect } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { Vector3 } from "three";
import { damp3 } from "maath/easing";
import { useAeroStore } from "@/store/useAeroStore";

const SMOOTHING = 0.4;

/**
 * CameraRig handles two modes:
 *
 * AI mode (default, manualRef = false)
 * ─────────────────────────────────────
 * damp3 smoothly animates camera.position and the lookAt target toward the
 * AI-chosen cameraConfig.  OrbitControls is disabled so it doesn't fight the
 * animation.  Once the camera settles (distance < 0.002), OrbitControls is
 * re-enabled and its internal state is synced to the final position.
 *
 * Manual mode (manualRef = true)
 * ───────────────────────────────
 * OrbitControls owns the camera.  drei runs OrbitControls.update() at frame
 * priority -1 (before this useFrame); we just keep currentLookAt in sync with
 * the controls target so it's available for the next AI command.
 *
 * User override mid-animation
 * ────────────────────────────
 * A capture-phase pointerdown listener fires BEFORE OrbitControls' own bubble-
 * phase handler.  It sets manualRef = true, syncs OrbitControls' target, and
 * enables OrbitControls — so the in-progress drag is handled correctly and
 * damp3 stops immediately.
 *
 * New AI command
 * ──────────────
 * When cameraConfig changes, the render body runs (CameraRig only re-renders
 * when cameraConfig changes), resetting manualRef = false, settledRef = false,
 * and imperatively disabling OrbitControls.  AI mode resumes.
 */
export function CameraRig() {
  const { camera, gl } = useThree();
  const cameraConfig  = useAeroStore((s) => s.cameraConfig);
  const setIsMoving   = useAeroStore((s) => s.setIsMoving);

  const controlsRef   = useRef<OrbitControlsImpl>(null);
  const currentLookAt = useRef(new Vector3(...cameraConfig.lookAt));
  const settledRef    = useRef(true);
  const manualRef     = useRef(false);

  // ── New AI command → reset to AI-controlled mode ─────────────────────────
  // This runs in the render body (synchronous, before any useFrame or useEffect
  // for this render cycle) whenever cameraConfig changes.
  settledRef.current = false;
  manualRef.current  = false;
  if (controlsRef.current) {
    controlsRef.current.enabled = false;
  }

  // ── User override: capture-phase pointerdown fires before OrbitControls ──
  // Setting enabled = true here means OrbitControls' own bubble-phase
  // pointerdown (which fires next) will register the drag start correctly.
  useEffect(() => {
    const canvas = gl.domElement;

    const onPointerDown = () => {
      if (manualRef.current) return; // already in manual mode

      if (controlsRef.current) {
        // Sync OrbitControls' target to wherever the camera is currently
        // looking so rotation starts from the right pivot point.
        controlsRef.current.target.copy(currentLookAt.current);
        controlsRef.current.update(); // recompute spherical coords from camera.position
        controlsRef.current.enabled = true;
      }
      manualRef.current = true;
      settledRef.current = true; // prevent AI settle logic from re-disabling controls
      setIsMoving(false);
    };

    // Capture phase: fires before OrbitControls' bubble-phase handler so
    // 'enabled' is already true when OrbitControls processes the same event.
    canvas.addEventListener("pointerdown", onPointerDown, { capture: true });
    return () => canvas.removeEventListener("pointerdown", onPointerDown, { capture: true });
  }, [gl, setIsMoving]);

  useFrame((_state, delta) => {
    // ── Manual mode: OrbitControls owns the camera ───────────────────────
    // drei calls OrbitControls.update() at priority -1 (before this frame).
    // We just keep currentLookAt in sync so the next AI command has a valid
    // starting lookAt for interpolation.
    if (manualRef.current) {
      if (controlsRef.current) {
        currentLookAt.current.copy(controlsRef.current.target);
      }
      return;
    }

    // ── AI animation mode ─────────────────────────────────────────────────
    const targetPos    = new Vector3(...cameraConfig.position);
    const targetLookAt = new Vector3(...cameraConfig.lookAt);

    damp3(camera.position, targetPos,    SMOOTHING, delta);
    damp3(currentLookAt.current, targetLookAt, SMOOTHING, delta);
    camera.lookAt(currentLookAt.current);

    const posClose  = camera.position.distanceTo(targetPos)    < 0.002;
    const lookClose = currentLookAt.current.distanceTo(targetLookAt) < 0.002;

    if (posClose && lookClose && !settledRef.current) {
      settledRef.current = true;
      setIsMoving(false);

      // Hand control back to OrbitControls once the AI animation completes.
      if (controlsRef.current) {
        controlsRef.current.target.copy(currentLookAt.current);
        controlsRef.current.update();
        controlsRef.current.enabled = true;
      }
    }
  });

  return (
    <OrbitControls
      ref={controlsRef}
      enableDamping
      dampingFactor={0.08}
      minDistance={0.5}
      maxDistance={15}
      minPolarAngle={Math.PI * 0.05}   // prevent looking straight up
      maxPolarAngle={Math.PI * 0.88}   // prevent clipping through the floor
    />
  );
}
