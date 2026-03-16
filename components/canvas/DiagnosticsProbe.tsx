"use client";

import { useEffect, useRef } from "react";
import { useThree, useFrame } from "@react-three/fiber";
import { Box3 } from "three";
import { useAeroStore } from "@/store/useAeroStore";
import {
  measureVerticalityError,
  detectBoundaryPlanes,
  applyFloorSnap,
} from "@/utils/diagnostics";
import { getRoomDimensions } from "@/utils/spatial";
import type { SpatialDiagnostics } from "@/types/diagnostics";

/**
 * How often (in rendered frames) the heavy diagnostic passes run.
 * 60 frames ≈ 1 s at 60 fps — enough resolution without blocking the main
 * thread during deep scans or high-res voxel passes.
 */
const DIAGNOSTICS_FRAME_INTERVAL = 60;

/**
 * Null-rendering canvas component that:
 *  1. Re-computes SpatialDiagnostics once every DIAGNOSTICS_FRAME_INTERVAL
 *     frames whenever the room or object list has changed (dirty-flag pattern).
 *     Moving the work into useFrame keeps it off the React commit path and
 *     away from scan-resolution hot-paths.
 *  2. Applies a floor-snap rotation to the GLTF scene when triggered.
 */
export function DiagnosticsProbe() {
  const { scene: threeScene } = useThree();

  const roomDimensions           = useAeroStore((s) => s.roomDimensions);
  const detectedObjects          = useAeroStore((s) => s.detectedObjects);
  const ceilingHeightSource      = useAeroStore((s) => s.ceilingHeightSource);
  const updateSpatialDiagnostics = useAeroStore((s) => s.updateSpatialDiagnostics);
  const pendingFloorSnap         = useAeroStore((s) => s.pendingFloorSnap);
  const clearFloorSnap           = useAeroStore((s) => s.clearFloorSnap);
  const gltfScene                = useAeroStore((s) => s._gltfScene);
  const setRoomDimensions        = useAeroStore((s) => s.setRoomDimensions);

  // ── Dirty flag ─────────────────────────────────────────────────────────────
  // Set whenever inputs that affect diagnostics change; cleared after the
  // throttled useFrame pass runs.
  const dirtyRef      = useRef(false);
  const frameCountRef = useRef(0);

  // Mark dirty whenever room, object count, or ceiling source changes.
  useEffect(() => {
    if (roomDimensions) dirtyRef.current = true;
  }, [roomDimensions, detectedObjects.length, ceilingHeightSource]);

  // ── Throttled diagnostic pass (useFrame, 1×/60 frames) ───────────────────
  useFrame(() => {
    frameCountRef.current += 1;
    if (
      frameCountRef.current % DIAGNOSTICS_FRAME_INTERVAL !== 0 ||
      !dirtyRef.current ||
      !roomDimensions
    ) return;

    dirtyRef.current = false;

    const verticalityError = measureVerticalityError(threeScene);
    const boundaryPlanes   = detectBoundaryPlanes(threeScene, roomDimensions);
    const openingsDetected = detectedObjects.filter((o) => o.isOpening).length;

    const diag: SpatialDiagnostics = {
      verticalityError,
      boundaryPlanes,
      ceilingHeightSource,
      openingsDetected,
    };

    updateSpatialDiagnostics(diag);
    console.log(
      `[DiagnosticsProbe] tilt=${verticalityError}° ` +
      `walls=${[boundaryPlanes.wallN, boundaryPlanes.wallS, boundaryPlanes.wallE, boundaryPlanes.wallW].filter(Boolean).length}/4 ` +
      `ceil=${boundaryPlanes.ceiling} openings=${openingsDetected}`,
    );
  });

  // ── Floor snap ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!pendingFloorSnap || !gltfScene) return;

    const corrected = applyFloorSnap(gltfScene);
    if (corrected) {
      // Refresh room dimensions after the geometry correction.
      threeScene.userData.boundingBox = new Box3().setFromObject(gltfScene);
      const dims = getRoomDimensions(threeScene);
      if (dims) setRoomDimensions(dims, "fallback");
      dirtyRef.current = true; // re-run diagnostics after snap
      console.log("[DiagnosticsProbe] Floor snap applied — room dims refreshed");
    } else {
      console.log("[DiagnosticsProbe] Floor snap: already level (< 1°)");
    }

    clearFloorSnap();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFloorSnap]);

  return null;
}
