"use client";

import { useRef, useEffect } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { Vector3, MathUtils, PerspectiveCamera } from "three";
import { useAeroStore } from "@/store/useAeroStore";

// ── Module-level store accessors (no subscriptions, no re-renders) ────────────
const getIsTouring    = () => useAeroStore.getState().isTouring;
const getDetectedObjs = () => useAeroStore.getState().detectedObjects;

// ── Spring parameters ─────────────────────────────────────────────────────────
// Position: slightly underdamped (ζ ≈ 0.72) so the camera drifts past each
// waypoint before the next target pulls it back — simulating inertia / gait.
const POS_K          = 7;     // spring stiffness
const POS_C          = 3.8;   // damping coefficient
// LookAt: near-critically damped — smooth pivot, no oscillation.
const LOOK_K         = 5;
const LOOK_C         = 4.5;
const MAX_SPEED      = 6;     // m/s velocity cap (prevents runaway on large jumps)
const SETTLE_DIST    = 0.08;  // metres — camera treated as settled below this
const SETTLE_SPEED   = 0.15;  // m/s   — camera treated as settled below this

// ── Inspection gaze (Lissajous figure-eight) ──────────────────────────────────
// Applied to lookAt once the camera settles at a tour vantage point.
// Interior feel: someone glancing around the room.
// Drone feel:    gimbal-stabilised inspection sweep.
const GAZE_AMP_H = 0.10;  // horizontal swing (metres of lookAt offset)
const GAZE_AMP_V = 0.04;  // vertical   swing
const GAZE_FREQ  = 0.35;  // ω in rad/s — full figure-eight every ≈ 18 s

// ── Proximity-based velocity ───────────────────────────────────────────────────
// Near isOpening objects or dense voxel clusters, the spring force is scaled down
// so the camera naturally slows to "pause and inspect".
const PROXIMITY_RADIUS = 2.5;  // trigger radius in metres
const PROXIMITY_MIN    = 0.60; // spring-force scale at the closest point (40% reduction)

// ── FOV elasticity ────────────────────────────────────────────────────────────
const FOV_SLOW      = 65;   // focused — inspecting / hovering
const FOV_FAST      = 80;   // wide    — fast travel between waypoints
const FOV_DEFAULT   = 60;   // manual-orbit baseline
const FOV_SPD_MAX   = 3.5;  // m/s at which FOV reaches FOV_FAST
const FOV_LERP_RATE = 0.05; // per-frame factor (applied every ~16 ms)

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns a [PROXIMITY_MIN, 1.0] spring-force scale.
 * Triggers: any isOpening object, or any solid object with volumeAccuracy ≥ 70.
 */
function proximityFactor(pos: Vector3): number {
  const objects = getDetectedObjs();
  let minDist = Infinity;
  for (const obj of objects) {
    const isProx = obj.isOpening || (obj.volumeAccuracy ?? 0) >= 70;
    if (!isProx) continue;
    const [ox, oy, oz] = obj.position3D;
    const d = Math.sqrt((pos.x - ox) ** 2 + (pos.y - oy) ** 2 + (pos.z - oz) ** 2);
    if (d < minDist) minDist = d;
  }
  if (minDist >= PROXIMITY_RADIUS) return 1.0;
  const t = minDist / PROXIMITY_RADIUS; // 0 = at trigger, 1 = at boundary
  return PROXIMITY_MIN + (1 - PROXIMITY_MIN) * t;
}

/** Maps camera speed to a target FOV (AI/tour mode only). */
function speedToFov(speed: number): number {
  const t = Math.min(1, speed / FOV_SPD_MAX);
  return FOV_SLOW + (FOV_FAST - FOV_SLOW) * t;
}

/**
 * CameraRig — Kinetic Exploration system.
 *
 * AI / Tour mode (manualRef = false)
 * ────────────────────────────────────
 * Underdamped spring simulation for camera position: the camera drifts slightly
 * past each waypoint before redirecting, simulating a drone's inertia or a
 * person's natural gait.  LookAt uses a stiffer, near-critically-damped spring
 * for smooth pivoting.  Once settled, a Lissajous figure-eight is overlaid on
 * the lookAt target during tour stops.
 *
 * Proximity-based velocity
 * ─────────────────────────
 * Near isOpening objects or dense voxel clusters, the spring stiffness is
 * reduced by up to 40 %, naturally slowing the camera for a "pause and inspect"
 * feel without hardcoding any room type.
 *
 * FOV elasticity
 * ──────────────
 * The perspective FOV is continuously interpolated based on the camera's speed:
 *   Fast travel → 80° (wide, emphasises space)
 *   Hovering    → 65° (focused, detail inspection)
 *   Manual mode → 60° (default orbit baseline)
 *
 * Manual mode (manualRef = true)
 * ───────────────────────────────
 * OrbitControls owns the camera.  The spring stops, FOV returns to 60°, and
 * currentLookAt stays in sync with the controls target.
 *
 * User override mid-animation
 * ────────────────────────────
 * A capture-phase pointerdown fires before OrbitControls' bubble handler.
 * It switches to manual mode, syncs OrbitControls, and zeroes velocity.
 * Blocked during tour so the cinematic sequence can't be interrupted.
 *
 * New AI command
 * ──────────────
 * Render-body code runs synchronously on cameraConfig change.  If transitioning
 * from manual mode, velocity is zeroed for a clean start.  If already in AI mode
 * (e.g. tour step advance), velocity is preserved — preserving momentum.
 */
export function CameraRig() {
  const { camera, gl } = useThree();
  const cameraConfig   = useAeroStore((s) => s.cameraConfig);
  const setIsMoving    = useAeroStore((s) => s.setIsMoving);

  const controlsRef   = useRef<OrbitControlsImpl>(null);
  const currentLookAt = useRef(new Vector3(...cameraConfig.lookAt));
  const settledRef    = useRef(true);
  const manualRef     = useRef(false);

  // ── Velocity refs — intentionally not reset on tour advance (keeps momentum) ─
  const posVelocity  = useRef(new Vector3());
  const lookVelocity = useRef(new Vector3());

  // ── Gaze-loop time accumulator ────────────────────────────────────────────
  const gazeTimeRef  = useRef(0);

  // ── Pre-allocated temp vectors (avoids per-frame GC pressure) ────────────
  const tv = useRef({
    targetPos: new Vector3(),
    targetLk:  new Vector3(),
    posErr:    new Vector3(),
    posAcc:    new Vector3(),
    lookErr:   new Vector3(),
    lookAcc:   new Vector3(),
    gaze:      new Vector3(),
    finalLk:   new Vector3(),
  }).current;

  // ── New AI command → switch to AI-controlled mode ─────────────────────────
  // Runs synchronously in the render body whenever cameraConfig changes.
  if (manualRef.current) {
    // Switching from manual → AI: start from rest so spring is clean.
    posVelocity.current.set(0, 0, 0);
    lookVelocity.current.set(0, 0, 0);
  }
  settledRef.current = false;
  manualRef.current  = false;
  if (controlsRef.current) {
    controlsRef.current.enabled = false;
  }

  // ── Capture-phase pointer: switch to manual mode ──────────────────────────
  useEffect(() => {
    const canvas = gl.domElement;

    const onPointerDown = () => {
      if (getIsTouring())    return; // tour owns the camera — block override
      if (manualRef.current) return; // already manual

      if (controlsRef.current) {
        controlsRef.current.target.copy(currentLookAt.current);
        controlsRef.current.update();
        controlsRef.current.enabled = true;
      }
      posVelocity.current.set(0, 0, 0);
      lookVelocity.current.set(0, 0, 0);
      manualRef.current  = true;
      settledRef.current = true;
      setIsMoving(false);
    };

    canvas.addEventListener("pointerdown", onPointerDown, { capture: true });
    return () => canvas.removeEventListener("pointerdown", onPointerDown, { capture: true });
  }, [gl, setIsMoving]);

  useFrame((_state, delta) => {
    // Clamp delta: prevents velocity explosion after a tab loses focus.
    const dt = Math.min(delta, 0.05);

    // ── Manual mode ──────────────────────────────────────────────────────────
    if (manualRef.current) {
      if (controlsRef.current) {
        currentLookAt.current.copy(controlsRef.current.target);
      }
      // Restore default FOV while the user is orbiting.
      const pc = camera as PerspectiveCamera;
      if (Math.abs(pc.fov - FOV_DEFAULT) > 0.1) {
        pc.fov = MathUtils.lerp(pc.fov, FOV_DEFAULT, FOV_LERP_RATE);
        pc.updateProjectionMatrix();
      }
      return;
    }

    // ── AI / Tour spring simulation ───────────────────────────────────────────
    const [px, py, pz] = cameraConfig.position;
    const [lx, ly, lz] = cameraConfig.lookAt;
    tv.targetPos.set(px, py, pz);
    tv.targetLk.set(lx, ly, lz);

    // ── Proximity factor: soften spring near openings / dense clusters ────────
    const pFactor = proximityFactor(camera.position);

    // ── Spring: camera position ───────────────────────────────────────────────
    tv.posErr.copy(tv.targetPos).sub(camera.position);
    tv.posAcc
      .copy(tv.posErr).multiplyScalar(POS_K * pFactor)
      .addScaledVector(posVelocity.current, -POS_C);
    posVelocity.current.addScaledVector(tv.posAcc, dt);
    // Velocity cap — prevents runaway on very large position jumps.
    const spd = posVelocity.current.length();
    if (spd > MAX_SPEED) posVelocity.current.multiplyScalar(MAX_SPEED / spd);
    camera.position.addScaledVector(posVelocity.current, dt);

    // ── Settle detection ──────────────────────────────────────────────────────
    const distToTarget = camera.position.distanceTo(tv.targetPos);
    const curSpeed     = posVelocity.current.length();

    if (distToTarget < SETTLE_DIST && curSpeed < SETTLE_SPEED && !settledRef.current) {
      settledRef.current = true;
      setIsMoving(false);
      // Hand orbit control back to the user only outside of the tour.
      if (!getIsTouring() && controlsRef.current) {
        controlsRef.current.target.copy(currentLookAt.current);
        controlsRef.current.update();
        controlsRef.current.enabled = true;
      }
    }

    // ── Spring: lookAt ────────────────────────────────────────────────────────
    tv.lookErr.copy(tv.targetLk).sub(currentLookAt.current);
    tv.lookAcc
      .copy(tv.lookErr).multiplyScalar(LOOK_K)
      .addScaledVector(lookVelocity.current, -LOOK_C);
    lookVelocity.current.addScaledVector(tv.lookAcc, dt);
    currentLookAt.current.addScaledVector(lookVelocity.current, dt);

    // ── Inspection gaze: Lissajous figure-eight overlay ──────────────────────
    // Active only when settled at a tour stop.  Creates the feel of someone
    // naturally scanning the room or a drone gimbal slowly sweeping a feature.
    tv.gaze.set(0, 0, 0);
    if (settledRef.current && getIsTouring()) {
      gazeTimeRef.current += dt;
      const t = gazeTimeRef.current;
      tv.gaze.set(
        GAZE_AMP_H * Math.sin(GAZE_FREQ * t),
        GAZE_AMP_V * Math.sin(2 * GAZE_FREQ * t),
        0,
      );
    }

    // ── Compose final lookAt and orient the camera ────────────────────────────
    tv.finalLk.copy(currentLookAt.current).add(tv.gaze);
    camera.lookAt(tv.finalLk);

    // ── FOV elasticity ────────────────────────────────────────────────────────
    // Velocity-driven: fast travel widens to 80°, hovering narrows to 65°.
    const pc        = camera as PerspectiveCamera;
    const targetFov = speedToFov(curSpeed);
    if (Math.abs(pc.fov - targetFov) > 0.1) {
      pc.fov = MathUtils.lerp(pc.fov, targetFov, FOV_LERP_RATE);
      pc.updateProjectionMatrix();
    }
  });

  return (
    <OrbitControls
      ref={controlsRef}
      enableDamping
      dampingFactor={0.08}
      minDistance={0.5}
      maxDistance={15}
      minPolarAngle={Math.PI * 0.05}  // prevent looking straight up
      maxPolarAngle={Math.PI * 0.88}  // prevent clipping through the floor
    />
  );
}
