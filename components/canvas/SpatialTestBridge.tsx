"use client";

import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import { Mesh, Vector3Tuple } from "three";
import { getObjectMeshBounds, profileRoomBoundaries } from "@/utils/spatial";
import { useAeroStore } from "@/store/useAeroStore";

/**
 * SpatialTestBridge — only active outside production.
 *
 * Mounts inside the R3F Canvas so it has access to useThree().
 * Exposes window.__vistaSpatialTest__ for Playwright spatial sanity tests:
 *
 *   measureAt(pos, radius?, name?)  → same return as getObjectMeshBounds
 *   getDetectedObjects()            → Zustand store snapshot
 *   ready                           → true once the scene is populated
 *
 * Usage in tests:
 *   await page.waitForFunction(() => window.__vistaSpatialTest__?.ready);
 *   const dims = await page.evaluate(pos =>
 *     window.__vistaSpatialTest__.measureAt(pos, 3.0, "bed"),
 *     [1.5, 0.4, -2.0]
 *   );
 *   expect(dims.width).toBeGreaterThan(1.5);
 */
export function SpatialTestBridge() {
  const { scene } = useThree();

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;

    // Poll until the GLB has actually mounted (Suspense may delay it).
    // Only expose `ready: true` once real Mesh geometry is present.
    let intervalId: ReturnType<typeof setInterval>;

    function tryRegister() {
      let meshCount = 0;
      scene.traverse((obj) => { if (obj instanceof Mesh) meshCount++; });
      if (meshCount === 0) return; // model still loading — try again

      clearInterval(intervalId);

      const dynamicBounds = profileRoomBoundaries(scene);

      (window as any).__vistaSpatialTest__ = {
        measureAt: (
          pos:    Vector3Tuple,
          radius = 2.5,
          name   = "",
        ) => getObjectMeshBounds(scene, pos, radius, name),

        listMeshes: () => {
          const info: Array<{ name: string; radius: number }> = [];
          scene.traverse((obj) => {
            if (!(obj instanceof Mesh)) return;
            const geom = obj.geometry;
            if (geom && !geom.boundingSphere) geom.computeBoundingSphere();
            info.push({ name: obj.name || "(unnamed)", radius: geom?.boundingSphere?.radius ?? 0 });
          });
          return info;
        },

        getDetectedObjects: () => useAeroStore.getState().detectedObjects,

        /** Dynamically detected room enclosure — use in tests to verify measurements are in-bounds. */
        dynamicBounds,

        ready: true,
      };
    }

    tryRegister();
    intervalId = setInterval(tryRegister, 250);

    return () => {
      clearInterval(intervalId);
      delete (window as any).__vistaSpatialTest__;
    };
  }, [scene]);

  return null;
}
