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

type BatchEntry = {
  snap: ReturnType<typeof captureSnapshotFromCamera>;
  cam: Camera;
};

export function ScanBridge() {
  const { gl, camera, scene } = useThree();
  const pendingScan    = useAeroStore((s) => s.pendingScan);
  const isDeepScanning = useAeroStore((s) => s.isDeepScanning);
  const batchRef       = useRef<BatchEntry[]>([]);

  useEffect(() => {
    if (!pendingScan) return;

    async function runScan() {
      const {
        resolveScan,
        deepScanProgress,
        deepScanTotal,
      } = useAeroStore.getState();

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

        function measureObject(
          obj: VisionObject,
          center3D: Vector3Tuple,
        ): { dims: { width: number; height: number; depth: number }; center: Vector3Tuple; voxelCount: number; clipping_warning?: boolean } | null {
          const result = getObjectMeshBounds(scene, center3D, 2.5, obj.name);
          if (!result) return null;
          const { width, height, depth, center, voxelCount, clipping_warning } = result;
          if (clipping_warning) {
            console.warn(
              `[ScanBridge] "${obj.name}" hit voxel cap — clipping_warning: true. ` +
              `Reported size may be truncated.`
            );
          }
          console.log(
            `[ScanBridge] "${obj.name}" voxel: ${width}×${height}×${depth} m ` +
            `cluster-center=(${center.map((n) => n.toFixed(2)).join(", ")}) ` +
            `voxels=${voxelCount}${clipping_warning ? " ⚠ CLIPPED" : ""}`
          );
          return { dims: { width, height, depth }, center, voxelCount, clipping_warning };
        }

        /** Calls Vision API with a pre-captured snapshot, then raycasts results. */
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

          const res = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              mode: "discover",
              image: snap.base64,
              mimeType: snap.mimeType,
              canvasWidth:  snap.width,
              canvasHeight: snap.height,
            }),
          });

          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            console.error(`[ScanBridge][${label}] Vision API error:`, err);
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

          // ── Final step: fire all API calls with 200ms stagger ─────────────
          const batch = [...batchRef.current];
          batchRef.current = [];
          console.log(
            `[ScanBridge] Firing ${batch.length} deep-scan API calls in parallel (200 ms stagger)`
          );

          const batchPromises = batch.map(
            (entry, i) =>
              new Promise<IncomingDetection[]>((resolve) => {
                setTimeout(async () => {
                  try {
                    const result = await processApiAndRaycast(entry.snap, entry.cam, `deep-${i + 1}`);
                    resolve(result);
                  } catch (err) {
                    console.error(`[ScanBridge] deep-${i + 1} failed:`, err);
                    resolve([]);
                  }
                }, i * 200);
              }),
          );

          const settled = await Promise.allSettled(batchPromises);
          const allDetections = settled
            .filter((r): r is PromiseFulfilledResult<IncomingDetection[]> => r.status === "fulfilled")
            .flatMap((r) => r.value);

          console.log(
            `[ScanBridge] Batch complete — ${allDetections.length} total detections from ${batch.length} passes`
          );
          resolveScan(allDetections);
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
        }
      } catch (err) {
        console.error("[ScanBridge] Scan pipeline failed:", err);
        batchRef.current = [];
        useAeroStore.getState().resolveScan([]);
      }
    }

    runScan();
  }, [pendingScan, gl, camera, scene, isDeepScanning]);

  return null;
}
