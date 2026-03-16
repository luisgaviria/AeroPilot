"use client";

import { useEffect, useRef } from "react";
import { useThree } from "@react-three/fiber";
import { Box3, Box3Helper, Camera, Color, PerspectiveCamera, Quaternion, Vector3, Vector3Tuple } from "three";
import { useAeroStore } from "@/store/useAeroStore";
import {
  captureSnapshotFromCamera,
  freezeCamera,
  raycastPixelTo3D,
  buildOverviewCamera,
  getObjectMeshBounds,
  ROOM_Y_MIN,
  ROOM_Y_MAX,
} from "@/utils/spatial";
import { IncomingDetection, VisionObject } from "@/types/auto-discovery";
import { STANDARD_ANCHORS } from "@/data/standardAnchors";

type BatchEntry = {
  snap: ReturnType<typeof captureSnapshotFromCamera>;
  cam: Camera;
};

export function ScanBridge() {
  const { gl, camera, scene } = useThree();
  const pendingScan         = useAeroStore((s) => s.pendingScan);
  const isDeepScanning      = useAeroStore((s) => s.isDeepScanning);
  const pendingIsolationUIDs = useAeroStore((s) => s.pendingIsolationUIDs);
  const batchRef             = useRef<BatchEntry[]>([]);

  useEffect(() => {
    if (!pendingScan) return;

    async function runScan() {
      const {
        resolveScan,
        deepScanProgress,
        deepScanTotal,
        spatialDiagnostics,
        globalScale,
      } = useAeroStore.getState();

      // ── Multi-Signal Environment Detection ────────────────────────────────
      // Human truth (a verified axis dimension) overrides unreliable sensor
      // data (wall count).  Even a single verified axis guarantees we are in
      // an interior — a partial sensor read should never force exterior mode.
      const bp = spatialDiagnostics?.boundaryPlanes;
      const wallsDetected = bp
        ? [bp.wallN, bp.wallS, bp.wallE, bp.wallW].filter(Boolean).length
        : 0;
      const { verifiedXAxis, verifiedYAxis, verifiedZAxis } = useAeroStore.getState();
      const hasVerifiedAxis = verifiedXAxis != null || verifiedYAxis != null || verifiedZAxis != null;
      const isInterior = wallsDetected >= 2 || hasVerifiedAxis;
      const verticalityError = spatialDiagnostics?.verticalityError ?? 0;

      // Interior: 8 cm Clearance Buffer — creates a geometric air gap that prevents
      // rug/tile mass from inflating the volume of floor-based objects, without
      // cutting into low-profile furniture legs (typical leg height ≥ 10 cm).
      // Exterior/drone: wider 35 cm buffer clears grass, curbs, and terrain noise.
      let bufferHeight = isInterior ? 0.08 : 0.35;
      // Terrain Guard: steep tilt on uneven terrain inflates buffer to prevent bleed.
      if (verticalityError > 5) bufferHeight = 0.5;

      console.log(
        `[SpatialPilot] Mode: ${isInterior ? "Room" : "Exterior"} ` +
        `(walls=${wallsDetected}, verifiedAxis=${hasVerifiedAxis}) | ` +
        `Buffer: ${bufferHeight}m | Scale Priority: UserTruth`
      );

      try {
        const frozenCamera = freezeCamera(camera);

        console.log(
          `[ScanBridge] camera frozen @ ` +
          `(${camera.position.x.toFixed(2)}, ${camera.position.y.toFixed(2)}, ${camera.position.z.toFixed(2)})`
        );

        const cssW   = gl.domElement.clientWidth;
        const cssH   = gl.domElement.clientHeight;
        const aspect = cssW / (cssH || 1);

        let snapCamera: Camera = frozenCamera;

        if (!isDeepScanning) {
          const overviewCam = buildOverviewCamera(scene, frozenCamera, aspect);
          if (overviewCam) {
            snapCamera = overviewCam;
            console.log(`[ScanBridge] using overview camera for single scan`);
          } else {
            console.warn(`[ScanBridge] buildOverviewCamera returned null — falling back to frozen camera`);
          }
        }

        function makeJitterCamera(cam: Camera, angleDeg: number): Camera {
          const rad = (angleDeg * Math.PI) / 180;
          const yRot = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), rad);
          const j = (cam as PerspectiveCamera).clone() as PerspectiveCamera;
          j.projectionMatrix.copy((cam as PerspectiveCamera).projectionMatrix);
          j.projectionMatrixInverse.copy((cam as PerspectiveCamera).projectionMatrixInverse);
          j.position.copy(cam.position).applyQuaternion(yRot);
          j.quaternion.copy(cam.quaternion).premultiply(yRot);
          j.updateMatrixWorld(true);
          return j;
        }

        /** Labels that imply a footprint ≥ 1.0 m² — trigger adaptive refinement if undersized. */
        const LARGE_FOOTPRINT_RE = /bed|sofa|couch|rug|carpet|sectional|loveseat|mattress/i;
        /** Minimum expected footprint (m²) for large-label objects. */
        const LARGE_FOOTPRINT_MIN = 1.0;

        // Room height — passed to getObjectMeshBounds for ceiling-proximity detection
        // and ceiling snap.  Falls back to undefined if not yet measured.
        const roomHeight = useAeroStore.getState().roomDimensions?.height;

        function measureObject(
          obj: VisionObject,
          center3D: Vector3Tuple,
        ): { dims: { width: number; height: number; depth: number }; center: Vector3Tuple; voxelCount: number; clipping_warning?: boolean } | null {
          const INITIAL_RADIUS = 2.5;
          let result = getObjectMeshBounds(scene, center3D, INITIAL_RADIUS, obj.name, { roomHeight, bufferHeight });
          if (!result) return null;

          // ── Adaptive refinement: if a large-label object has a small footprint,
          //    search harder with a wider radius and a looser neck-detection threshold.
          if (
            LARGE_FOOTPRINT_RE.test(obj.name) &&
            result.width * result.depth < LARGE_FOOTPRINT_MIN
          ) {
            const refinedRadius = INITIAL_RADIUS * 2;
            console.log(
              `[ScanBridge] "${obj.name}" footprint=${(result.width * result.depth).toFixed(2)} m² < ${LARGE_FOOTPRINT_MIN} — ` +
              `retrying with radius=${refinedRadius} neckMinWidth=1`
            );
            const refined = getObjectMeshBounds(
              scene,
              center3D,
              refinedRadius,
              obj.name,
              { neckMinWidth: 1, roomHeight, bufferHeight },
            );
            if (refined && refined.width * refined.depth > result.width * result.depth) {
              console.log(
                `[ScanBridge] "${obj.name}" refinement improved footprint ` +
                `${(result.width * result.depth).toFixed(2)} → ${(refined.width * refined.depth).toFixed(2)} m²`
              );
              result = refined;
            } else {
              console.log(`[ScanBridge] "${obj.name}" refinement did not improve footprint — keeping original`);
            }
          }

          const { width, height, depth, center, voxelCount, clipping_warning } = result;
          if (clipping_warning) {
            console.warn(
              `[ScanBridge] "${obj.name}" hit voxel cap — clipping_warning: true. ` +
              `Reported size may be truncated.`
            );
          }

          // ── Point 3: Normalize to raw mesh units ───────────────────────────
          // Divide by the current globalScale so rawMeshDimensions are stored in
          // pre-scale coordinates.  reapplyAndValidate then applies globalScale to
          // produce the calibrated real-world measurement, preventing double-scaling
          // when globalScale ≠ 1 (e.g. after a ruler commit or verified dimension).
          const gx = Math.max(globalScale.x, 0.01);
          const gy = Math.max(globalScale.y, 0.01);
          const gz = Math.max(globalScale.z, 0.01);
          const normW = +(width  / gx).toFixed(3);
          const normH = +(height / gy).toFixed(3);
          const normD = +(depth  / gz).toFixed(3);

          console.log(
            `[ScanBridge] "${obj.name}" voxel: ${width}×${height}×${depth} m ` +
            `→ normalized: ${normW}×${normH}×${normD} (÷ gs ${gx.toFixed(3)}/${gy.toFixed(3)}/${gz.toFixed(3)}) ` +
            `cluster-center=(${center.map((n) => n.toFixed(2)).join(", ")}) ` +
            `voxels=${voxelCount}${clipping_warning ? " ⚠ CLIPPED" : ""}`
          );
          return { dims: { width: normW, height: normH, depth: normD }, center, voxelCount, clipping_warning };
        }

        /** Pause until the tab is visible; polls every 1 s while hidden. */
        async function waitForVisible(): Promise<void> {
          while (
            typeof document !== "undefined" &&
            document.visibilityState !== "visible"
          ) {
            console.log("[ScanBridge] Tab not visible — pausing batch for 1 s");
            await new Promise<void>((r) => setTimeout(r, 1_000));
          }
        }

        /**
         * Calls Vision API with a pre-captured snapshot, then raycasts results.
         * Retries once (after 1 s) on 500 / 503 / 504 errors.
         */
        async function processApiAndRaycast(
          snap: ReturnType<typeof captureSnapshotFromCamera>,
          cam: Camera,
          label: string,
        ): Promise<IncomingDetection[]> {
          console.log(
            `[ScanBridge][${label}] snapshot ${snap.width}×${snap.height} ` +
            (gl.domElement.clientWidth !== snap.width || gl.domElement.clientHeight !== snap.height
              ? "⚠ MISMATCH" : "✓")
          );

          const RETRYABLE = new Set([500, 503, 504]);
          const body = JSON.stringify({
            mode: "discover",
            image: snap.base64,
            mimeType: snap.mimeType,
            canvasWidth:  snap.width,
            canvasHeight: snap.height,
          });
          const fetchOpts: RequestInit = {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          };

          let res = await fetch("/api/chat", fetchOpts);

          // ── 1-time retry on transient server errors ──────────────────────
          if (!res.ok && RETRYABLE.has(res.status)) {
            const errText = await res.text().catch(() => "(unreadable)");
            console.warn(
              `[ScanBridge][${label}] HTTP ${res.status} — retrying in 1 000 ms. Body: ${errText}`
            );
            await new Promise<void>((r) => setTimeout(r, 1_000));
            res = await fetch("/api/chat", fetchOpts);
          }

          if (!res.ok) {
            const errText = await res.text().catch(() => "(unreadable)");
            console.error(
              `[ScanBridge][${label}] Vision API error HTTP ${res.status}: ${errText}`
            );
            return [];
          }

          const { objects } = (await res.json()) as { objects: VisionObject[] };
          console.log(
            `[ScanBridge][${label}] API returned ${objects.length} object(s):`,
            objects.map((o) => `${o.name}(${o.x},${o.y}) conf=${o.confidence?.toFixed(2) ?? "?"}`).join(" | ")
          );

          const hits: IncomingDetection[] = [];
          for (const obj of objects) {
            const pos3D = raycastPixelTo3D(obj.x, obj.y, snap.width, snap.height, cam, scene, obj.name, 2.0);
            if (!pos3D) {
              console.warn(`[ScanBridge][${label}] ✗ "${obj.name}" at pixel(${obj.x},${obj.y}) — no 3D hit`);
              continue;
            }
            if (pos3D.y < ROOM_Y_MIN || pos3D.y > ROOM_Y_MAX) {
              console.warn(
                `[ScanBridge][${label}] ✗ "${obj.name}" — y=${pos3D.y.toFixed(2)} outside ` +
                `[${ROOM_Y_MIN}, ${ROOM_Y_MAX}], discarded`
              );
              continue;
            }
            const raycastCenter = pos3D.toArray() as Vector3Tuple;
            const measured = measureObject(obj, raycastCenter);

            const position3D = measured?.center ?? raycastCenter;

            console.log(
              `[ScanBridge][${label}] ✓ "${obj.name}" pixel(${obj.x},${obj.y}) → ` +
              `3D(${pos3D.x.toFixed(2)}, ${pos3D.y.toFixed(2)}, ${pos3D.z.toFixed(2)})` +
              (measured ? ` → cluster(${position3D.map((n) => n.toFixed(2)).join(", ")})` : "")
            );
            hits.push({
              name:        obj.name,
              position3D,
              pixelCoords: { x: obj.x, y: obj.y },
              confidence:  obj.confidence,
              dimensions:  measured?.dims,
              voxelCount:  measured?.voxelCount,
            });

            if (measured) {
              const [cx, cy, cz] = measured.center;
              const { width, height, depth } = measured.dims;
              const helper = new Box3Helper(
                new Box3(
                  new Vector3(cx - width / 2, cy - height / 2, cz - depth / 2),
                  new Vector3(cx + width / 2, cy + height / 2, cz + depth / 2),
                ),
                new Color(measured.clipping_warning ? 0xffaa00 : 0xff2222),
              );
              helper.name = `__dbg_${obj.name}__`;
              scene.add(helper);
              setTimeout(() => {
                scene.remove(helper);
                helper.geometry.dispose();
                (helper.material as any).dispose?.();
              }, 5_000);
            }
          }
          return hits;
        }

        /** Full capture + API + raycast for a given camera. */
        async function scanWithCamera(cam: Camera, label: string): Promise<IncomingDetection[]> {
          const snap = captureSnapshotFromCamera(gl, scene, cam, cssW, cssH);
          return processApiAndRaycast(snap, cam, label);
        }

        if (isDeepScanning) {
          // ── Batch-collect phase ────────────────────────────────────────────
          // Capture snapshot without calling the Vision API.
          const snap = captureSnapshotFromCamera(gl, scene, snapCamera, cssW, cssH);
          batchRef.current.push({ snap, cam: snapCamera });
          console.log(`[ScanBridge] deep batch: captured step ${deepScanProgress}/${deepScanTotal}`);

          if (deepScanProgress < deepScanTotal) {
            // Not the final step — unblock triggerDeepScan to move camera to next position.
            resolveScan([]);
            return;
          }

          // ── Final step: fire in two batches of 4, 500 ms intra-batch stagger ──
          const batch = [...batchRef.current];
          batchRef.current = [];

          const BATCH_SIZE   = 4;
          const INTRA_STAGGER = 500; // ms between calls within a batch
          const batch1 = batch.slice(0, BATCH_SIZE);
          const batch2 = batch.slice(BATCH_SIZE);

          console.log(
            `[ScanBridge] Firing deep-scan in 2 batches ` +
            `(${batch1.length} + ${batch2.length}) with ${INTRA_STAGGER} ms intra-stagger`
          );

          // Pause if the tab is hidden before we start firing.
          await waitForVisible();

          const allPromises: Promise<IncomingDetection[]>[] = [];

          // ── Batch 1 ───────────────────────────────────────────────────────
          for (let i = 0; i < batch1.length; i++) {
            const entry = batch1[i];
            const idx   = i;
            allPromises.push(
              new Promise<IncomingDetection[]>((resolve) => {
                setTimeout(async () => {
                  await waitForVisible();
                  try {
                    resolve(await processApiAndRaycast(entry.snap, entry.cam, `deep-${idx + 1}`));
                  } catch (err) {
                    console.error(`[ScanBridge] deep-${idx + 1} failed:`, err);
                    resolve([]);
                  }
                }, idx * INTRA_STAGGER);
              }),
            );
          }

          // Wait until every batch-1 call has been INITIATED before starting batch 2.
          await new Promise<void>((r) =>
            setTimeout(r, (batch1.length - 1) * INTRA_STAGGER),
          );

          // ── Batch 2 ───────────────────────────────────────────────────────
          for (let i = 0; i < batch2.length; i++) {
            const entry    = batch2[i];
            const globalIdx = BATCH_SIZE + i;
            allPromises.push(
              new Promise<IncomingDetection[]>((resolve) => {
                setTimeout(async () => {
                  await waitForVisible();
                  try {
                    resolve(await processApiAndRaycast(entry.snap, entry.cam, `deep-${globalIdx + 1}`));
                  } catch (err) {
                    console.error(`[ScanBridge] deep-${globalIdx + 1} failed:`, err);
                    resolve([]);
                  }
                }, i * INTRA_STAGGER);
              }),
            );
          }

          const settled = await Promise.allSettled(allPromises);
          const allDetections = settled
            .filter((r): r is PromiseFulfilledResult<IncomingDetection[]> => r.status === "fulfilled")
            .flatMap((r) => r.value);

          console.log(
            `[ScanBridge] Batch complete — ${allDetections.length} total detections from ${batch.length} passes`
          );
          resolveScan(allDetections);
          // Auto-save only when detections were actually collected
          if (allDetections.length > 0) {
            useAeroStore.getState().saveCurrentRoom().catch((err) =>
              console.error("[ScanBridge] Auto-save (deep scan) failed:", err)
            );
          }
        } else {
          // Single scan: two passes (normal + 2° jitter) — merge before resolving.
          const [pass1, pass2] = await Promise.all([
            scanWithCamera(snapCamera, "pass1"),
            scanWithCamera(makeJitterCamera(snapCamera, 2), "pass2"),
          ]);
          const detected = [...pass1, ...pass2];
          console.log(
            `[ScanBridge] Jitter merge — pass1: ${pass1.length}, pass2: ${pass2.length}, total: ${detected.length}`
          );
          resolveScan(detected);
          // Auto-save after every successful single scan
          useAeroStore.getState().saveCurrentRoom().catch((err) =>
            console.error("[ScanBridge] Auto-save (scan) failed:", err)
          );
        }
      } catch (err) {
        console.error("[ScanBridge] Scan pipeline failed:", err);
        batchRef.current = [];
        useAeroStore.getState().resolveScan([]);
      }
    }

    runScan();
  }, [pendingScan, gl, camera, scene, isDeepScanning]);

  // ── Voxel Isolation — targeted re-measurement for Sanity Guard triggers ────
  useEffect(() => {
    if (pendingIsolationUIDs.length === 0) return;

    const {
      detectedObjects, resolveVoxelIsolation, roomDimensions,
      spatialDiagnostics,
    } = useAeroStore.getState();
    const roomHeight = roomDimensions?.height;

    // ── Multi-Signal isolation context ────────────────────────────────────
    const ibp = spatialDiagnostics?.boundaryPlanes;
    const iWallsDetected = ibp
      ? [ibp.wallN, ibp.wallS, ibp.wallE, ibp.wallW].filter(Boolean).length
      : 0;
    const { verifiedXAxis: ivX, verifiedYAxis: ivY, verifiedZAxis: ivZ } = useAeroStore.getState();
    const iHasVerifiedAxis = ivX != null || ivY != null || ivZ != null;
    const iIsInterior = iWallsDetected >= 2 || iHasVerifiedAxis;
    const iVertError = spatialDiagnostics?.verticalityError ?? 0;
    let iBufferHeight = iIsInterior ? 0.08 : 0.35;
    if (iVertError > 5) iBufferHeight = 0.5;

    // Exterior structures (buildings, facades) get a double-wide radius so the
    // voxel engine can find the full footprint, but the bottom-cut stays in place
    // so the house doesn't merge with the driveway or ground mesh.
    const EXTERIOR_STRUCTURE_RE = /building|structure|house|facade|exterior|barn|shed/i;
    const BASE_ISOLATION_RADIUS = 5.0;

    for (const uid of pendingIsolationUIDs) {
      const obj = detectedObjects.find((o) => o.uid === uid);
      if (!obj) {
        resolveVoxelIsolation(uid, null);
        continue;
      }

      const isExteriorStructure = EXTERIOR_STRUCTURE_RE.test(obj.name);
      const isolationRadius = isExteriorStructure ? BASE_ISOLATION_RADIUS * 2 : BASE_ISOLATION_RADIUS;

      // ── Point 5: Performance Check — neck detection only when significantly diverged ──
      // Neck detection (neckMinWidth BFS) is expensive. Only run it when the object's
      // current width overshoots the anchor's sanityMax by >20%, which indicates genuine
      // merged-geometry contamination. A marginal overshoot (<20%) doesn't justify the
      // CPU cost — a plain radius/buffer adjustment is sufficient.
      const iAnchor = STANDARD_ANCHORS.find((a) => a.pattern.test(obj.name));
      const currentW = obj.dimensions?.width ?? 0;
      const sanityDiv = iAnchor?.sanityMax && iAnchor.sanityMax > 0
        ? (currentW - iAnchor.sanityMax) / iAnchor.sanityMax
        : 0;
      const useNeckDetection = sanityDiv > 0.20;

      console.log(
        `[ScanBridge] Voxel Isolation for "${obj.name}" (uid=${uid}) ` +
        `mode=${iIsInterior ? "Room" : "Exterior"} ` +
        `buffer=${iBufferHeight}m radius=${isolationRadius}m ` +
        `neckDetect=${useNeckDetection} (sanityDiv=${(sanityDiv * 100).toFixed(0)}%)` +
        `${isExteriorStructure ? " [exterior structure — wide radius, bottom-cut held]" : ""} ` +
        `at (${obj.position3D.map((n) => n.toFixed(2)).join(", ")})`
      );

      const isolated = getObjectMeshBounds(
        scene,
        obj.position3D,
        isolationRadius,
        obj.name,
        { neckMinWidth: useNeckDetection ? 1 : undefined, roomHeight, bufferHeight: iBufferHeight },
      );

      if (isolated) {
        const { width, height, depth } = isolated;
        console.log(
          `[ScanBridge] Voxel Isolation "${obj.name}" raw result: ` +
          `${width.toFixed(3)}×${height.toFixed(3)}×${depth.toFixed(3)} m ` +
          `(normalisation to unscaled space delegated to resolveVoxelIsolation)`
        );
        // Pass raw Three.js world-unit dims — resolveVoxelIsolation owns the
        // ÷ globalScale invariant so rawMeshDimensions is always in 1.0× space.
        resolveVoxelIsolation(uid, { width, height, depth });
      } else {
        console.warn(`[ScanBridge] Voxel Isolation "${obj.name}" — no geometry found, keeping original`);
        resolveVoxelIsolation(uid, null);
      }
    }

    // Auto-save after all isolation passes resolve — dimensions may have changed
    useAeroStore.getState().saveCurrentRoom().catch((err) =>
      console.error("[ScanBridge] Auto-save (isolation) failed:", err)
    );
  }, [pendingIsolationUIDs, scene]);

  return null;
}
