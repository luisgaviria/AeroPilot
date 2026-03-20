"use client";

import { Canvas } from "@react-three/fiber";
import { Suspense } from "react";
import { Environment, Html, Line } from "@react-three/drei";
import { useAeroStore } from "@/store/useAeroStore";
import { DetectedObject } from "@/types/auto-discovery";
import { Vector3Tuple } from "three";
import * as THREE from "three";
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

/**
 * Glowing 3D navigation pin at the centre of each scanned room.
 * Click to teleport the camera to that room and make it active.
 */
function RoomNavPins() {
  const rooms          = useAeroStore((s) => s.rooms);
  const activeRoomId   = useAeroStore((s) => s.activeRoomId);
  const navigateToRoom = useAeroStore((s) => s.navigateToRoom);

  if (rooms.length === 0) return null;

  return (
    <>
      {rooms.map((room) => {
        const isActive = room.id === activeRoomId;
        const color    = isActive ? "#38bdf8" : "#818cf8";   // sky-400 : indigo-400
        return (
          <group key={room.id} position={[room.centerX, 0, room.centerZ]}>
            {/* Glowing beacon cylinder */}
            <mesh
              position={[0, 0.06, 0]}
              onPointerDown={(e) => {
                e.stopPropagation();
                navigateToRoom(room.id);
              }}
            >
              <cylinderGeometry args={[0.10, 0.10, 0.12, 16]} />
              <meshStandardMaterial
                color={color}
                emissive={color}
                emissiveIntensity={isActive ? 3 : 1.5}
                toneMapped={false}
              />
            </mesh>

            {/* Ambient point-light glow */}
            <pointLight color={color} intensity={isActive ? 2 : 0.8} distance={2} />

            {/* Room name label */}
            <Html
              position={[0, 0.35, 0]}
              center
              distanceFactor={5}
              zIndexRange={[100, 100]}
              wrapperClass="pointer-events-none"
            >
              <div
                style={{ pointerEvents: "none" }}
                className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-semibold shadow-md backdrop-blur-sm whitespace-nowrap ${
                  isActive
                    ? "border-sky-400/50 bg-sky-500/20 text-sky-200"
                    : "border-indigo-400/30 bg-black/60 text-indigo-200/80"
                }`}
              >
                {room.name}
                <span className="font-normal opacity-60">
                  {room.widthM.toFixed(1)}×{room.lengthM.toFixed(1)}m
                </span>
              </div>
            </Html>
          </group>
        );
      })}
    </>
  );
}

/** Arrow directions for room snapping. */
const SNAP_DIRS = [
  { dir: "N" as const, rotation: [0, 0, Math.PI / 2]  as [number, number, number], offset: (l: number) => [0, 0, -(l / 2 + 0.4)]  as Vector3Tuple },
  { dir: "S" as const, rotation: [0, 0, -Math.PI / 2] as [number, number, number], offset: (l: number) => [0, 0,  (l / 2 + 0.4)]  as Vector3Tuple },
  { dir: "E" as const, rotation: [0, 0, -Math.PI]     as [number, number, number], offset: (w: number) => [ (w / 2 + 0.4), 0, 0]  as Vector3Tuple },
  { dir: "W" as const, rotation: [0, 0, 0]            as [number, number, number], offset: (w: number) => [-(w / 2 + 0.4), 0, 0]  as Vector3Tuple },
];

/**
 * 4 clickable directional arrows on the active room's bounding box.
 * Clicking an arrow snaps the room face to the nearest adjacent room.
 */
function RoomSnapArrows() {
  const rooms          = useAeroStore((s) => s.rooms);
  const activeRoomId   = useAeroStore((s) => s.activeRoomId);
  const snapActiveRoom = useAeroStore((s) => s.snapActiveRoom);

  const active = rooms.find((r) => r.id === activeRoomId);
  if (!active || rooms.length < 1) return null;

  return (
    <group position={[active.centerX, 0.08, active.centerZ]}>
      {SNAP_DIRS.map(({ dir, rotation, offset }) => {
        const pos = dir === "N" || dir === "S"
          ? offset(active.lengthM)
          : offset(active.widthM);
        return (
          <mesh
            key={dir}
            position={pos}
            rotation={rotation as unknown as THREE.Euler}
            onPointerDown={(e) => {
              e.stopPropagation();
              snapActiveRoom(dir);
            }}
          >
            <coneGeometry args={[0.12, 0.28, 8]} />
            <meshStandardMaterial
              color="#f59e0b"
              emissive="#f59e0b"
              emissiveIntensity={2}
              toneMapped={false}
            />
          </mesh>
        );
      })}

      {/* AABB outline of the active room */}
      <primitive
        object={new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.BoxGeometry(active.widthM, 0.01, active.lengthM)),
          new THREE.LineBasicMaterial({ color: "#f59e0b", opacity: 0.35, transparent: true }),
        )}
      />
    </group>
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

      {/* Room navigation pins — glowing beacons at room centres */}
      <RoomNavPins />

      {/* Room snap arrows — directional alignment controls for active room */}
      <RoomSnapArrows />

      {/* Reference Ruler — invisible capture plane + marker spheres */}
      <RulerCapturePlane />
      <RulerMarkers />

      {/* Playwright test bridge — no-ops in production */}
      <SpatialTestBridge />
    </Canvas>
  );
}
