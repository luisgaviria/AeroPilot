"use client";

import { Canvas } from "@react-three/fiber";
import { Suspense } from "react";
import { Environment, Html, Line } from "@react-three/drei";
import { useAeroStore } from "@/store/useAeroStore";
import { DetectedObject } from "@/types/auto-discovery";
import { Vector3Tuple } from "three";
import { Model } from "./Model";
import { CameraRig } from "./CameraRig";
import { ScanBridge } from "./ScanBridge";
import { SpatialTestBridge } from "./SpatialTestBridge";
import { DiagnosticsProbe } from "./DiagnosticsProbe";

/**
 * AR-style HTML label anchored to a 3D world position.
 *
 * Layout (bottom-to-top, matching typical AR pointer style):
 *   • violet dot      — the exact 3D anchor point
 *   • gradient line   — thin vertical connector
 *   • glass bubble    — name + confidence chip
 *
 * occlude="rootScene" hides the label whenever geometry sits between the
 * camera and the anchor — labels disappear behind walls automatically.
 */
function SpatialLabel({ obj }: { obj: DetectedObject }) {
  const conf = obj.confidence !== undefined ? Math.round(obj.confidence * 100) : null;

  return (
    <Html
      position={obj.position3D}
      occlude="rootScene"
      center
      distanceFactor={6}
      zIndexRange={[0, 0]}
      wrapperClass="pointer-events-none"
      style={{ pointerEvents: "none" }}
    >
      {/* Outer wrapper: centred on the anchor, grows upward */}
      <div
        style={{ transform: "translate(-50%, -100%)", pointerEvents: "none" }}
        className="flex flex-col items-center gap-0"
      >
        {/* ── Glass text bubble ─────────────────────────────────────── */}
        <div className="flex items-center gap-1.5 rounded-lg border border-violet-400/20 bg-black/55 px-2.5 py-[5px] shadow-md shadow-black/40 backdrop-blur-sm whitespace-nowrap">
          <span className="text-[11px] font-semibold leading-none tracking-wide text-white/90">
            {obj.name.charAt(0).toUpperCase() + obj.name.slice(1)}
          </span>
          {conf !== null && (
            <span className="rounded-sm bg-violet-500/20 px-1 py-px text-[9px] font-medium leading-none text-violet-300/80">
              {conf}%
            </span>
          )}
        </div>

        {/* ── Connector line ─────────────────────────────────────────── */}
        <div
          className="w-px"
          style={{
            height: "14px",
            background: "linear-gradient(to bottom, rgba(167,139,250,0.45), rgba(167,139,250,0.08))",
          }}
        />

        {/* ── Anchor dot ─────────────────────────────────────────────── */}
        <div className="h-[7px] w-[7px] rounded-full bg-violet-400/80 shadow-[0_0_5px_1px_rgba(167,139,250,0.5)]" />
      </div>
    </Html>
  );
}

/**
 * Large invisible floor plane that intercepts pointer clicks during Reference Ruler mode.
 * Clicking anywhere on the floor records the world-space position as a ruler point.
 */
function RulerCapturePlane() {
  const rulerActive  = useAeroStore((s) => s.rulerActive);
  const addRulerPoint = useAeroStore((s) => s.addRulerPoint);

  if (!rulerActive) return null;

  return (
    <mesh
      position={[0, 0.005, 0]}
      rotation={[-Math.PI / 2, 0, 0]}
      onPointerDown={(e) => {
        e.stopPropagation();
        addRulerPoint([e.point.x, e.point.y, e.point.z] as Vector3Tuple);
      }}
    >
      <planeGeometry args={[400, 400]} />
      {/* Fully transparent — only exists to receive pointer events */}
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  );
}

/**
 * Renders cyan/amber spheres at placed ruler points and a dashed line between them.
 * Only visible while ruler mode is active.
 */
function RulerMarkers() {
  const rulerPoints = useAeroStore((s) => s.rulerPoints);
  const rulerActive = useAeroStore((s) => s.rulerActive);

  if (!rulerActive || rulerPoints.length === 0) return null;

  return (
    <>
      {rulerPoints.map((pt, i) => (
        <mesh key={i} position={pt}>
          <sphereGeometry args={[0.06, 16, 16]} />
          <meshBasicMaterial color={i === 0 ? "#22d3ee" : "#f59e0b"} />
        </mesh>
      ))}
      {rulerPoints.length === 2 && (
        <Line
          points={rulerPoints}
          color="#22d3ee"
          lineWidth={2}
          dashed
          dashSize={0.12}
          gapSize={0.06}
        />
      )}
    </>
  );
}

/** Renders a persistent AR label for every detected object (hidden during cinematic tour). */
function SpatialLabels() {
  const detectedObjects = useAeroStore((s) => s.detectedObjects);
  const isTouring       = useAeroStore((s) => s.isTouring);

  if (isTouring) return null;

  return (
    <>
      {detectedObjects.map((obj) => (
        <SpatialLabel key={obj.uid} obj={obj} />
      ))}
    </>
  );
}

export function Scene() {
  return (
    <Canvas
      camera={{ position: [0, 1.6, 4], fov: 60, near: 0.1, far: 100 }}
      // preserveDrawingBuffer is required so gl.domElement.toDataURL()
      // captures the rendered frame instead of returning a blank image.
      gl={{ antialias: true, preserveDrawingBuffer: true }}
      shadows
      className="w-full h-full"
    >
      <ambientLight intensity={0.4} />
      <directionalLight position={[5, 10, 5]} intensity={1} castShadow />

      <Environment preset="apartment" />

      <Suspense fallback={null}>
        <Model />
      </Suspense>

      <CameraRig />

      {/* Scan bridge: watches pendingScan, runs Capture→Vision→Raycaster pipeline */}
      <ScanBridge />

      {/* AR labels for all detected objects */}
      <SpatialLabels />

      {/* Geometry diagnostics + floor-snap handler */}
      <DiagnosticsProbe />

      {/* Reference Ruler — invisible capture plane + marker spheres */}
      <RulerCapturePlane />
      <RulerMarkers />

      {/* Playwright test bridge — no-ops in production */}
      <SpatialTestBridge />
    </Canvas>
  );
}
