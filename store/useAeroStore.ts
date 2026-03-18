import { create } from "zustand";
import { Object3D, Vector3Tuple } from "three";
import { locations } from "@/data/locations";
import { DetectedObject, IncomingDetection, TourStop } from "@/types/auto-discovery";
import type { RoomDimensions } from "@/utils/spatial";
import { computeScaleFactor, scaleDims, applyScaleVector, applyHybridValidation, applyRawDepthOverrides, type AnchorMatch, type ScaleVector3 } from "@/utils/semanticScale";
import { STANDARD_ANCHORS } from "@/data/standardAnchors";
import type { SpatialDiagnostics } from "@/types/diagnostics";
import { buildSpatialManifest, type SpatialManifest } from "@/utils/diagnostics";
import type { SpatialDigest } from "@/types/spatialDigest";
import { buildSpatialDigest, classifyTier, digestFingerprint } from "@/utils/spatialDigest";
import { supabase } from "@/lib/supabase";
import { RoomSchema, EntitySchema, SpatialStatsSchema, SpatialModeSchema } from "@/types/spatialSchema";
import type { SpatialStatsPayload, SpatialMode } from "@/types/spatialSchema";

// ── Room name ─────────────────────────────────────────────────────────────────
const ROOM_NAME_KEY    = "vista_room_name";
const LOCKED_SCALE_KEY = "vista_locked_scale";

function loadRoomName(): string | null {
  if (typeof window === "undefined") return null;
  try { return localStorage.getItem(ROOM_NAME_KEY) ?? null; } catch { return null; }
}

function loadLockedScale(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(LOCKED_SCALE_KEY);
    if (!raw) return null;
    const n = parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}

export interface CameraConfig {
  position: Vector3Tuple;
  lookAt: Vector3Tuple;
}

interface AeroState {
  // ── Camera ────────────────────────────────────────────────────────────────
  targetLocation: string;
  isMoving: boolean;
  cameraConfig: CameraConfig;
  setTargetLocation: (id: string, config: CameraConfig) => void;
  setIsMoving: (moving: boolean) => void;

  // ── Spatial context (set once after model loads) ──────────────────────────
  roomDimensions: RoomDimensions | null;
  setRoomDimensions: (dims: RoomDimensions | null, source?: "measured" | "fallback") => void;

  // ── AI Chat ───────────────────────────────────────────────────────────────
  aiMessage: string;
  isThinking: boolean;
  sendMessage: (userMessage: string) => Promise<void>;
  clearHistory: () => void;
  /**
   * Pre-computed spatial summary sent to the chat API instead of raw object
   * data.  Rebuilt only when scan data or room dimensions change (latency guard).
   */
  spatialDigest:  SpatialDigest | null;
  /** Fingerprint used to gate digest rebuilds — prevents recalculation on every render. */
  _digestKey:     string;

  // ── Persistence ───────────────────────────────────────────────────────────
  /**
   * Supabase row ID for the currently loaded room.
   * Set after a successful saveCurrentRoom or loadRoom call.
   */
  currentRoomId:   string | null;
  /**
   * Human-readable name used as the Supabase upsert key.
   * Defaults to the current targetLocation when not explicitly set.
   */
  currentRoomName: string | null;
  setCurrentRoomName: (name: string | null) => void;
  /**
   * Persist the current room state (dimensions, verified axes, all detected
   * entities) to Supabase.  Validated through Zod before any write.
   * Silently skipped when roomDimensions is null.
   */
  saveCurrentRoom: () => Promise<void>;
  /**
   * Hydrate the store from a named Supabase room record.
   * Validates incoming data through Zod; restores all verified-axis ground truth.
   */
  loadRoom: (roomName: string) => Promise<void>;
  /**
   * Clear all scan + calibration state to prepare for a fresh isolated property.
   * Resets detected objects, dimensions, verified axes, digest, and room identity.
   */
  resetForNewScan: () => void;
  /**
   * Spatial Sandbox — hydrate the store directly from an exported SpatialManifest JSON.
   * Instantly restores 3D objects, labels, room dimensions, and scale factor from a
   * previously saved scan file.  No API call is made; the manifest is the ground truth.
   * Safe to call repeatedly to switch between different scan files.
   */
  loadSandboxManifest: (manifest: SpatialManifest) => void;
  /**
   * Tri-state embedding status for the last saveCurrentRoom call.
   *   null  — no save attempted yet in this session.
   *   true  — last save successfully wrote a 768-dim embedding to Supabase.
   *   false — last save attempted but embedding failed (spatial data still saved).
   */
  _vectorSynced: boolean | null;
  /**
   * Dashboard statistics hydrated from Supabase on loadRoom.
   * Allows the dashboard to display instantly without waiting for a re-scan.
   */
  persistedStats: {
    floorOccupancyPct:   number | null;
    tightestClearanceM:  number | null;
    maxWallAvailableM:   number | null;
  } | null;

  // ── Spatial Mode ──────────────────────────────────────────────────────────
  /**
   * Interpretation context for the scanned space.
   *   'room'      — enclosed interior with walls/ceiling (default).
   *   'open-plan' — interior without full wall enclosure.
   *   'outdoor'   — exterior ground-level space.
   *   'aerial'    — drone / elevated overhead view.
   * Persisted to Supabase with the room record.
   */
  spatialMode:    SpatialMode;
  setSpatialMode: (mode: SpatialMode) => void;

  // ── Auto-Discovery ────────────────────────────────────────────────────────
  detectedObjects: DetectedObject[];
  pendingScan: boolean;
  isScanning: boolean;
  isDeepScanning: boolean;
  deepScanProgress: number; // 1–N during deep scan, 0 otherwise
  deepScanTotal: number;    // 4 (quick) or 8 (deep)
  scanMode: "quick" | "deep";
  setScanMode: (mode: "quick" | "deep") => void;
  triggerScan: () => void;
  triggerDeepScan: () => void;
  resolveScan: (incoming: IncomingDetection[]) => void;
  /** Annotated snapshot data-URL set after each scan for visual debugging. */
  debugSnapshot: string | null;
  setDebugSnapshot: (url: string | null) => void;
  /** Persisted scan progress — restored after page reload mid-deep-scan. */
  scanCheckpoint: { progress: number; detectedObjects: DetectedObject[] } | null;

  // ── Semantic Scale Calibration ────────────────────────────────────────────
  /** Auto-computed uniform scale factor derived from semantic anchors (1.0 = no correction). */
  autoScaleFactor: number;
  /**
   * "Tape Measure" uniform override.  When set, takes precedence over autoScaleFactor for
   * all axes that do not have an independent per-axis verified room dimension.
   * Persisted to localStorage so it survives page reload.
   */
  verifiedScaleFactor: number | null;
  /**
   * Per-axis scale vector — the single source of truth for displayed dimensions.
   *   x: from verifiedXAxis / baseMesh.width   (or fallback to metricRatio)
   *   y: from verifiedYAxis / baseMesh.height
   *   z: from verifiedZAxis / baseMesh.length
   * displayedDimensions = rawMeshDimensions × globalScale (component-wise).
   */
  globalScale: ScaleVector3;
  /**
   * The single best uniform scale ratio — displayed in the UI as the primary metric truth.
   * Priority: rulerRatio > average(verified dim ratios) > null.
   * Used as the TIER-2 base in computeGlobalScale when no per-axis override exists.
   */
  metricRatio: number | null;
  /** Per-anchor match log from the most recent scale computation. */
  anchorLog: AnchorMatch[];
  /** Set (or clear) the manual verified scale factor. */
  setVerifiedScaleFactor: (factor: number | null) => void;
  /**
   * Scale Lock — TIER 0 in computeGlobalScale.
   * When non-null, ALL semantic/room/ruler scale computations are bypassed and
   * every scan will use this exact uniform factor.  Persisted to localStorage.
   */
  _lockedScale: number | null;
  /**
   * Set or clear the Scale Lock.
   * Pass a number to lock; pass null to unlock and revert to normal auto-computation.
   */
  setManualScale: (factor: number | null) => void;
  /**
   * Mark a specific detected object as user-verified with exact real-world dimensions.
   * When set, globalScale is bypassed for this object and verifiedDimensions are displayed.
   */
  setObjectVerifiedDimensions: (uid: string, dims: { width: number; height: number; depth: number }) => void;

  // ── Spatial Diagnostics ───────────────────────────────────────────────────
  spatialDiagnostics: SpatialDiagnostics | null;
  updateSpatialDiagnostics: (d: SpatialDiagnostics) => void;

  // ── Manual Data Injection ─────────────────────────────────────────────────
  /** How the active ceiling height was derived. */
  ceilingHeightSource: "verified" | "measured" | "fallback";
  /**
   * Raw mesh-derived room dimensions stored at model load.  Never overwritten
   * by verified values — serves as the immutable baseline for resolveRoomDimensions.
   */
  _baseMeshDimensions: RoomDimensions | null;
  /** User-injected Y-axis (ceiling / altitude) override in metres. Persisted to vista_spatial_config. */
  verifiedYAxis: number | null;
  /** User-injected X-axis (room width / E-W extent) override in metres. Persisted to vista_spatial_config. */
  verifiedXAxis: number | null;
  /** User-injected Z-axis (room length / N-S extent) override in metres. Persisted to vista_spatial_config. */
  verifiedZAxis: number | null;
  setVerifiedYAxis: (h: number | null) => void;
  setVerifiedXAxis: (v: number | null) => void;
  setVerifiedZAxis: (v: number | null) => void;

  // ── Reference Ruler ───────────────────────────────────────────────────────
  /** True while the user is placing Reference Ruler markers in the 3D scene. */
  rulerActive: boolean;
  /** 0, 1, or 2 world-space positions placed by the Reference Ruler. */
  rulerPoints: Vector3Tuple[];
  /** Raw ratio persisted from the last committed ruler measurement (no baseMesh needed). */
  _rulerRatio: number | null;
  setRulerActive:    (active: boolean) => void;
  addRulerPoint:     (pt: Vector3Tuple) => void;
  clearRuler:        () => void;
  /**
   * Commit a ruler measurement.
   * metricRatio = realMetres / threejsDist — stored to localStorage and applied immediately.
   */
  commitRulerRatio:  (threejsDist: number, realMetres: number) => void;

  // ── Voxel Isolation ───────────────────────────────────────────────────────
  /**
   * UIDs of objects that failed the Sanity Guard (width > anchor.sanityMax).
   * ScanBridge watches this list and re-runs getObjectMeshBounds with a tighter
   * neckMinWidth=1 for each UID, then calls resolveVoxelIsolation.
   * User-verified objects are never added here — their tape measure always wins.
   */
  pendingIsolationUIDs: string[];
  queueVoxelIsolation:   (uid: string) => void;
  /**
   * Called by ScanBridge after the targeted re-measurement completes.
   * Accepts `null` when the isolation pass found nothing better.
   * Only updates rawMeshDimensions when the new bounding box is strictly smaller.
   */
  resolveVoxelIsolation: (uid: string, newDims: { width: number; height: number; depth: number } | null) => void;

  // ── Floor Snap ────────────────────────────────────────────────────────────
  /** True while DiagnosticsProbe should apply a floor-snap correction. */
  pendingFloorSnap: boolean;
  triggerFloorSnap: () => void;
  clearFloorSnap:   () => void;
  /**
   * Reference to the loaded GLTF scene Object3D — set by Model.tsx so that
   * DiagnosticsProbe can apply geometry mutations (floor snap, re-centre).
   */
  _gltfScene: Object3D | null;
  setGltfScene: (obj: Object3D) => void;

  // ── Export ────────────────────────────────────────────────────────────────
  exportSpatialManifest: () => void;

  // ── Cinematic Tour ────────────────────────────────────────────────────────
  isTouring: boolean;
  tourIndex: number;
  /** Pre-computed geometric stop sequence (corner vantages + opening sweeps). */
  tourStops: TourStop[];
  /** Room-level spatial metrics displayed in the Agent Card. */
  spatialClearance: {
    totalArea: number;
    walkableArea: number;
    spatialCertainty: number;
  } | null;
  /** Push a narrative message directly without calling the API. */
  setAiMessage: (msg: string) => void;
  startTour: () => void;
  stopTour: () => void;
  tourAdvance: () => void;
}

// ─── Pure helpers (no store access needed) ────────────────────────────────────

/** Normalise an AI-returned room ID to match our locations.ts keys. */
function normaliseId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

/** Always return a fresh CameraConfig so Zustand's reference check
 *  triggers a CameraRig re-render even when navigating to the same room twice. */
function freshConfig(c: CameraConfig): CameraConfig {
  return {
    position: [...c.position] as Vector3Tuple,
    lookAt: [...c.lookAt] as Vector3Tuple,
  };
}

/**
 * Build a camera config that zooms into a 3D point.
 *
 * Rather than always offsetting in world +Z (which can clip through walls),
 * we approach from the direction the camera is already coming from. We project
 * the camera-to-target vector onto the XZ plane, normalise it, then step back
 * DIST units along that direction with a fixed eye height above the target.
 */
function zoomConfig(target: Vector3Tuple, fromCamera: Vector3Tuple): CameraConfig {
  const [tx, ty, tz] = target;
  const [cx, , cz] = fromCamera;

  // XZ direction from target toward the current camera position
  const dx = cx - tx;
  const dz = cz - tz;
  const len = Math.sqrt(dx * dx + dz * dz) || 1;

  const DIST = 1.8; // how far back from the target to place the camera
  const EYE_LIFT = 0.9; // how far above the target surface the eye sits

  return freshConfig({
    position: [tx + (dx / len) * DIST, ty + EYE_LIFT, tz + (dz / len) * DIST],
    lookAt: [tx, ty, tz],
  });
}

// ─── Deep scan ────────────────────────────────────────────────────────────────

/**
 * Camera stays at the room centre (eye height 1.6 m) and rotates to face
 * four cardinal directions.  All four together produce a full 360° sweep.
 */
const DEEP_SCAN_STEPS: CameraConfig[] = [
  // ── Pass 1: Eye-level cardinal (1.6 m) — standard sweep ─────────────────────
  { position: [0, 1.6, 0], lookAt: [0, 1.2, -5] },  // 0°   – forward / north
  { position: [0, 1.6, 0], lookAt: [5, 1.2,  0] },  // 90°  – right   / east
  { position: [0, 1.6, 0], lookAt: [0, 1.2,  5] },  // 180° – back    / south
  { position: [0, 1.6, 0], lookAt: [-5, 1.2, 0] },  // 270° – left    / west
  // ── Pass 2: Low-angle cardinal (1.0 m) — captures nooks & under-furniture ───
  { position: [0, 1.0, 0], lookAt: [0, 0.3, -3] },  // N-low — forward nook
  { position: [0, 1.0, 0], lookAt: [3, 0.3,  0] },  // E-low — right nook
  { position: [0, 1.0, 0], lookAt: [0, 0.3,  3] },  // S-low — back nook
  { position: [0, 1.0, 0], lookAt: [-3, 0.3, 0] },  // W-low — left nook
];

const DEEP_SCAN_TOTAL = DEEP_SCAN_STEPS.length; // 8

/**
 * Per-step budget for camera settling AND scan completion during a deep scan.
 * Raised to 25 s to accommodate the 0.05 m high-res voxel pass which adds
 * significant BFS work on dense geometry.
 */
const DEEP_SCAN_STEP_TIMEOUT = 25_000; // ms

/** Resolves once `predicate` returns true, or rejects after `timeout` ms. */
function waitFor(predicate: () => boolean, timeout = DEEP_SCAN_STEP_TIMEOUT): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      clearInterval(poll);
      reject(new Error("Deep scan step timed out"));
    }, timeout);
    const poll = setInterval(() => {
      if (predicate()) {
        clearInterval(poll);
        clearTimeout(deadline);
        resolve();
      }
    }, 100);
  });
}

// ─── Cinematic tour — geometric/structural ────────────────────────────────────

const TOUR_EYE_HEIGHT  = 1.6;
const TOUR_LOOK_HEIGHT = 1.2;
/** Inset from each wall so the camera doesn't clip geometry. */
const CORNER_INSET     = 0.6;
/** Distance from the opening the camera stands during a sweep. */
const SWEEP_CAM_DIST   = 1.8;

/**
 * Build the ordered sequence of geometric tour stops from room enclosure
 * boundaries and any detected openings.
 *
 *  • 3 corner vantages, each aimed at the room's centre of mass.
 *  • 1 pair of sweep stops (left-edge → right-edge) per detected opening.
 *
 * No object labels, no regex — purely spatial.
 */
export function buildTourStops(
  room: RoomDimensions,
  detectedObjects: DetectedObject[],
): TourStop[] {
  const hw = room.width  / 2;
  const hl = room.length / 2;

  // Centre of mass — average position3D of all detected objects, else origin.
  const objs = detectedObjects;
  const cx = objs.length
    ? objs.reduce((s, o) => s + o.position3D[0], 0) / objs.length
    : 0;
  const cz = objs.length
    ? objs.reduce((s, o) => s + o.position3D[2], 0) / objs.length
    : 0;
  const lookAtCenter: Vector3Tuple = [cx, TOUR_LOOK_HEIGHT, cz];

  // 3 corner positions forming a triangle inside the room boundary.
  const cornerPositions: Vector3Tuple[] = [
    [-hw + CORNER_INSET, TOUR_EYE_HEIGHT, -hl + CORNER_INSET], // NW
    [+hw - CORNER_INSET, TOUR_EYE_HEIGHT, -hl + CORNER_INSET], // NE
    [0,                  TOUR_EYE_HEIGHT, +hl - CORNER_INSET], // S-centre
  ];

  const stops: TourStop[] = cornerPositions.map((position, i) => ({
    kind:        "corner" as const,
    position,
    lookAt:      lookAtCenter,
    cornerIndex: i,
    durationMs:  6000,
  }));

  // Sweep stops — one left/right pair per opening.
  const openings = detectedObjects.filter((o) => o.isOpening && o.dimensions);
  for (const opening of openings) {
    const [ox, oy, oz] = opening.position3D;
    const halfW = (opening.dimensions!.width) / 2;

    // Step back from the opening toward the room's centre of mass.
    const dx  = cx - ox;
    const dz  = cz - oz;
    const len = Math.sqrt(dx * dx + dz * dz) || 1;

    // Height adaptability: if the opening is elevated (window, roof vent),
    // glide the camera up to meet it rather than staying at eye height.
    const openingCenterY = opening.position3D[1];
    const halfH          = (opening.dimensions!.height ?? 0) / 2;
    const openingBottomY = Math.max(0, openingCenterY - halfH);
    const sweepCamY      = openingBottomY > 1.4
      ? Math.min(openingCenterY + 0.2, 3.2) // elevated — glide up to the feature
      : TOUR_EYE_HEIGHT;                     // floor-level — standard eye height

    const camPos: Vector3Tuple = [
      ox + (dx / len) * SWEEP_CAM_DIST,
      sweepCamY,
      oz + (dz / len) * SWEEP_CAM_DIST,
    ];

    // Perpendicular axis in XZ for the horizontal sweep.
    const perpX = -dz / len;
    const perpZ =  dx / len;
    const lookY = openingCenterY; // aim at the true centre of the gap

    stops.push({
      kind:         "sweep" as const,
      position:     camPos,
      lookAt:       [ox - perpX * halfW, lookY, oz - perpZ * halfW],
      sweepPhase:   "left",
      openingWidth: opening.dimensions!.width,
      durationMs:   3000,
    });
    stops.push({
      kind:         "sweep" as const,
      position:     camPos,
      lookAt:       [ox + perpX * halfW, lookY, oz + perpZ * halfW],
      sweepPhase:   "right",
      openingWidth: opening.dimensions!.width,
      durationMs:   3000,
    });
  }

  return stops;
}

/**
 * Compute room-level spatial clearance metrics for the Agent Card.
 *
 * totalArea       — authoritative floor area from the 2D voxel map.
 * walkableArea    — totalArea minus the footprint of every solid object.
 * spatialCertainty — composite score: avg volumeAccuracy × scan coverage,
 *                   representing how well the voxel engine captured the space.
 */
export function computeSpatialClearance(
  room: RoomDimensions,
  detectedObjects: DetectedObject[],
): { totalArea: number; walkableArea: number; spatialCertainty: number } {
  const totalArea = room.floorArea;

  const footprintSum = detectedObjects
    .filter((o) => !o.isOpening && o.dimensions)
    .reduce((s, o) => s + o.dimensions!.width * o.dimensions!.depth, 0);

  const walkableArea = Math.max(0, +(totalArea - footprintSum).toFixed(1));

  const solidObjects = detectedObjects.filter((o) => !o.isOpening);
  const withAccuracy = solidObjects.filter((o) => o.volumeAccuracy !== undefined);

  let spatialCertainty = 0;
  if (withAccuracy.length > 0) {
    const avgAcc  = withAccuracy.reduce((s, o) => s + (o.volumeAccuracy ?? 0), 0) / withAccuracy.length;
    const coverage = withAccuracy.length / Math.max(1, solidObjects.length);
    spatialCertainty = Math.min(99, Math.round(avgAcc * coverage));
  }

  return { totalArea, walkableArea, spatialCertainty };
}

// ─── Zoom-intent pattern ──────────────────────────────────────────────────────

/** Matches phrases like "zoom in on the couch", "focus on TV", "show me the table". */
const ZOOM_RE = /(?:zoom\s+in\s+on|focus\s+on|show\s+me|look\s+at)\s+(?:the\s+)?(.+)/i;

// ─── Scan checkpoint ──────────────────────────────────────────────────────────

const CHECKPOINT_KEY = "vista_scan_checkpoint";

function loadCheckpoint(): DetectedObject[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(CHECKPOINT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { detectedObjects?: DetectedObject[] };
    return parsed.detectedObjects ?? [];
  } catch {
    return [];
  }
}

function saveCheckpoint(progress: number, detectedObjects: DetectedObject[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify({ progress, detectedObjects }));
  } catch {}
}

function clearCheckpoint(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(CHECKPOINT_KEY);
  } catch {}
}

// ─── Room-dimension resolver ──────────────────────────────────────────────────

/**
 * Apply verified override values on top of the raw mesh-derived baseline.
 *
 * Rules:
 *  • Each verified dimension replaces its mesh counterpart exactly — no
 *    voxel-gap or bounding-box offset is applied.
 *  • floorArea is overridden with a simple (length × width) product only when
 *    BOTH a verified length AND a verified width are present, ensuring the
 *    number displayed in the dashboard matches the owner's tape measure.
 *  • When either dimension is not yet verified, the mesh-derived value is kept.
 */
function resolveRoomDimensions(
  base:    RoomDimensions,
  vHeight: number | null,
  vLength: number | null,
  vWidth:  number | null,
): RoomDimensions {
  const height = vHeight ?? base.height;
  const length = vLength ?? base.length;
  const width  = vWidth  ?? base.width;
  const floorArea =
    vLength != null && vWidth != null
      ? +(length * width).toFixed(2)
      : base.floorArea;
  return { width, length, height, floorArea };
}

// ─── Scale helpers ────────────────────────────────────────────────────────────

/**
 * Derive the single best uniform scale ratio from all available verified sources.
 *
 * Priority:
 *  1. rulerRatio  — a direct geometric measurement (most authoritative).
 *  2. Average of any per-axis ratios the user has verified (globalX / Z / ceiling).
 *  3. null — nothing verified yet.
 *
 * This value is stored as `metricRatio` in the store and displayed in the UI.
 * It feeds into computeGlobalScale as the TIER-2 base so that unmeasured axes
 * inherit the best available ratio rather than the AI-semantic auto-factor.
 */
function deriveMetricRatio(
  rulerRatio: number | null,
  baseMesh:   RoomDimensions | null,
  vYAxis:     number | null,
  vXAxis:     number | null,
  vZAxis:     number | null,
): number | null {
  if (rulerRatio != null) return rulerRatio;
  if (!baseMesh) return null;
  const factors: number[] = [];
  if (vXAxis != null && baseMesh.width  > 0) factors.push(vXAxis / baseMesh.width);
  if (vZAxis != null && baseMesh.length > 0) factors.push(vZAxis / baseMesh.length);
  if (vYAxis != null && baseMesh.height > 0) factors.push(vYAxis / baseMesh.height);
  if (factors.length === 0) return null;
  return +(factors.reduce((s, v) => s + v, 0) / factors.length).toFixed(4);
}

/**
 * Derive the per-axis global scale vector.
 *
 * Three-tier priority model:
 *
 * TIER 1 — Room Geometry (master, when ANY verified dim is present)
 *   Per-axis ratio = verifiedDim / baseMeshDim.
 *   Axes without their own override inherit the average of verified-axis ratios.
 *   Semantic anchors are bypassed entirely.
 *
 * TIER 2 — metricRatio (when no per-axis room dims, but a ruler or aggregated ratio exists)
 *   All three axes receive the single best uniform ratio.
 *
 * TIER 3 — Semantic / tape-measure fallback (nothing geometric is verified)
 *   Uniform factor = verifiedScaleFactor ?? autoScaleFactor.
 *
 * x = Width axis (Global X / E-W)   y = Height / ceiling axis   z = Length axis (Global Z / N-S)
 */
function computeGlobalScale(
  lockedScale:     number | null,   // TIER 0 — hard lock, overrides everything
  autoFactor:      number,
  uniformOverride: number | null,
  metricRatio:     number | null,
  baseMesh:        RoomDimensions | null,
  vYAxis:          number | null,   // ceiling / altitude
  vZAxis:          number | null,   // room length (N-S extent)
  vXAxis:          number | null,   // room width  (E-W extent)
): ScaleVector3 {
  // ── TIER 0: Scale Lock — user-set hard override ───────────────────────────
  if (lockedScale != null) {
    console.log(`[ScaleSync] Scale LOCKED at ${lockedScale.toFixed(4)}× — semantic/room computations bypassed`);
    return { x: lockedScale, y: lockedScale, z: lockedScale };
  }

  // Per-axis room ratios where both a verified value and the mesh baseline are known.
  const axisX = baseMesh && vXAxis != null ? +(vXAxis / baseMesh.width ).toFixed(4) : null;
  const axisY = baseMesh && vYAxis != null ? +(vYAxis / baseMesh.height).toFixed(4) : null;
  const axisZ = baseMesh && vZAxis != null ? +(vZAxis / baseMesh.length).toFixed(4) : null;

  const roomFactors = [axisX, axisY, axisZ].filter((v): v is number => v != null);

  if (roomFactors.length > 0) {
    // ── TIER 1: Room geometry is the master ───────────────────────────────────
    const roomMaster = +(roomFactors.reduce((s, v) => s + v, 0) / roomFactors.length).toFixed(4);
    const result: ScaleVector3 = {
      x: axisX ?? roomMaster,
      y: axisY ?? roomMaster,
      z: axisZ ?? roomMaster,
    };
    console.log(
      `[ScaleSync] Syncing furniture to Room Scale (X:${result.x.toFixed(4)}) — ` +
      `master=${roomMaster.toFixed(4)}, ${roomFactors.length}/3 axis/axes verified, semantic bypassed`
    );
    return result;
  }

  // ── TIER 2: metricRatio from ruler or aggregated dim ratios ───────────────
  if (metricRatio != null) {
    console.log(`[ScaleSync] Syncing furniture to metricRatio (X:${metricRatio.toFixed(4)})`);
    return { x: metricRatio, y: metricRatio, z: metricRatio };
  }

  // ── TIER 3: Semantic / tape-measure fallback ──────────────────────────────
  const base = uniformOverride ?? autoFactor;
  return { x: base, y: base, z: base };
}

/**
 * Re-apply the current global scale vector to every object in the array.
 *
 * Skip rules (in order):
 *  • isUserVerified + verifiedDimensions → owner confirmed exact size; bypass scale entirely.
 *  • !rawMeshDimensions → first-scan immutable baseline not yet captured; leave dimensions as-is.
 */
function reapplyScale(objects: DetectedObject[], gs: ScaleVector3): DetectedObject[] {
  return objects.map((o) => {
    if (o.isUserVerified && o.verifiedDimensions) return o;
    if (!o.rawMeshDimensions) return o;
    return { ...o, dimensions: applyScaleVector(o.rawMeshDimensions, gs) };
  });
}

/**
 * Full scale pipeline: geometric scaling → Hybrid Validation.
 *
 * 1. reapplyScale      — rawMeshDimensions × globalScale per axis (room geometry is master).
 * 2. applyHybridValidation — for each object with a semantic anchor, compare the geometric
 *    size to the standard.  ≤ 15 % → 70/30 blend (high-confidence).  > 15 % → conflict flag.
 *
 * This is the single call-site for all reactive scale updates (resolveScan + all setters).
 */
function reapplyAndValidate(objects: DetectedObject[], gs: ScaleVector3): DetectedObject[] {
  return applyHybridValidation(reapplyScale(objects, gs));
}

// ─── Sanity Guard ─────────────────────────────────────────────────────────────

/**
 * After scaling, find any object whose measured width exceeds the anchor's
 * sanityMax.  These are candidates for a targeted Voxel Isolation re-run.
 *
 * Skip rules:
 *  • isUserVerified — the owner's tape measure always beats the AI's sanity limit.
 *  • No dimensions yet — nothing to check.
 *  • No matching anchor or anchor has no sanityMax — no limit defined.
 *
 * Returns UIDs that need isolation (de-duplicated against already-pending list).
 */
function collectSanityTriggers(
  objects:       DetectedObject[],
  alreadyQueued: string[],
): string[] {
  const triggers: string[] = [];
  for (const obj of objects) {
    if (obj.isUserVerified)              continue;
    if (!obj.dimensions)                 continue;
    if (alreadyQueued.includes(obj.uid)) continue;
    const anchor = STANDARD_ANCHORS.find((a) => a.pattern.test(obj.name));
    if (!anchor?.sanityMax)              continue;
    if (obj.dimensions.width > anchor.sanityMax) {
      console.warn(
        `[AeroPilot] Sanity trigger for "${obj.name}" (uid=${obj.uid}). ` +
        `width=${obj.dimensions.width.toFixed(3)}m > sanityMax=${anchor.sanityMax}m. ` +
        `Running Voxel Isolation...`
      );
      triggers.push(obj.uid);
    }
  }
  return triggers;
}

// ─── Spatial Summary (for vector embedding) ───────────────────────────────────

/**
 * Build a dense natural-language paragraph describing the scanned space.
 * This text is sent to Gemini text-embedding-004 to produce a 768-dim vector
 * that captures the semantic and physical characteristics of the space.
 *
 * Design principles:
 *  • Consistent structure so semantically similar rooms produce nearby vectors.
 *  • Concrete numbers (dimensions, object count) anchor the embedding in real space.
 *  • No filler phrases — every token should carry signal.
 */
function generateSpatialSummary(
  roomName:        string,
  spatialMode:     SpatialMode,
  roomDimensions:  RoomDimensions,
  detectedObjects: DetectedObject[],
): string {
  const modeLabel: Record<SpatialMode, string> = {
    "room":      "enclosed interior room",
    "open-plan": "open-plan interior",
    "outdoor":   "outdoor ground-level space",
    "aerial":    "aerial overhead view",
  };

  const { width, length, height } = roomDimensions;
  const floorArea = roomDimensions.floorArea ?? +(width * length).toFixed(2);

  const solid    = detectedObjects.filter((o) => !o.isOpening && o.dimensions);
  const openings = detectedObjects.filter((o) => o.isOpening);

  const furnitureList = solid.length > 0
    ? solid.map((o) => o.name).join(", ")
    : "no furniture detected";

  const openingNote = openings.length > 0
    ? ` It has ${openings.length} opening(s) (doors/windows/passageways).`
    : "";

  return (
    `"${roomName}" is an ${modeLabel[spatialMode]} ` +
    `measuring ${width.toFixed(2)} m wide × ${length.toFixed(2)} m long × ${height.toFixed(2)} m tall ` +
    `(${floorArea} m² floor area). ` +
    `It contains: ${furnitureList}.` +
    openingNote
  );
}

// ─── Spatial Digest helpers ────────────────────────────────────────────────────

/**
 * Rebuilds the SpatialDigest only when the fingerprint has changed.
 * Call this at the end of any store mutation that may alter object dims/positions
 * or room dimensions.  Returns the new digest (or the existing one if unchanged).
 */
function rebuildDigestIfChanged(
  objects:        DetectedObject[],
  roomDimensions: RoomDimensions | null,
  currentKey:     string,
): { spatialDigest: SpatialDigest | null; _digestKey: string } {
  const newKey = digestFingerprint(objects, roomDimensions);
  if (newKey === currentKey) return { spatialDigest: null, _digestKey: currentKey };
  return { spatialDigest: buildSpatialDigest(objects, roomDimensions), _digestKey: newKey };
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useAeroStore = create<AeroState>((set, get) => ({
  // ── Camera ────────────────────────────────────────────────────────────────
  targetLocation: "living-room",
  isMoving: false,
  cameraConfig: {
    position: [0, 1.6, 4],
    lookAt: [0, 1, 0],
  },

  setTargetLocation: (id, config) =>
    set({ targetLocation: id, cameraConfig: freshConfig(config), isMoving: true }),

  setIsMoving: (moving) => set({ isMoving: moving }),

  // ── Spatial context ───────────────────────────────────────────────────────
  roomDimensions: null,
  setRoomDimensions: (dims, source = "fallback") => {
    const { verifiedYAxis, verifiedXAxis, verifiedZAxis,
            autoScaleFactor, verifiedScaleFactor, _rulerRatio, detectedObjects } = get();
    if (dims != null) {
      // Persist the raw mesh baseline — never overwritten by verified values.
      set({ _baseMeshDimensions: dims });

      // ── Scale-Snap ──────────────────────────────────────────────────────────
      // Immediately apply all stored verified ratios the moment the model loads.
      // This ensures furniture is correctly scaled before the first scan pass.
      const snapMetricRatio = deriveMetricRatio(_rulerRatio, dims, verifiedYAxis, verifiedXAxis, verifiedZAxis);
      const snapGlobalScale = computeGlobalScale(
        get()._lockedScale,
        autoScaleFactor, verifiedScaleFactor, snapMetricRatio, dims,
        verifiedYAxis, verifiedZAxis, verifiedXAxis,
      );
      set({
        metricRatio: snapMetricRatio,
        globalScale: snapGlobalScale,
        detectedObjects: reapplyAndValidate(detectedObjects, snapGlobalScale),
      });
    }
    const resolved = dims == null
      ? null
      : resolveRoomDimensions(dims, verifiedYAxis, verifiedXAxis, verifiedZAxis);

    // Rebuild digest — room dimensions affect wall clearances
    const { _digestKey: dk, detectedObjects: latestObjs } = get();
    const digestUpdate = rebuildDigestIfChanged(latestObjs, resolved, dk);

    set({
      roomDimensions:      resolved,
      ceilingHeightSource: verifiedYAxis != null ? "verified" : source,
      ...(digestUpdate.spatialDigest ? digestUpdate : {}),
    });
  },

  // ── AI Chat ───────────────────────────────────────────────────────────────
  aiMessage:       "",
  isThinking:      false,
  spatialDigest:   null,
  _digestKey:      "",
  currentRoomId:   null,
  currentRoomName: loadRoomName(),
  persistedStats:  null,
  _vectorSynced:   null as boolean | null,
  spatialMode:     "room" as SpatialMode,

  clearHistory:       () => set({ aiMessage: "" }),
  setCurrentRoomName: (name) => {
    if (typeof window !== "undefined") {
      if (name) localStorage.setItem(ROOM_NAME_KEY, name);
      else localStorage.removeItem(ROOM_NAME_KEY);
    }
    set({ currentRoomName: name });
  },

  setSpatialMode: (mode) => set({ spatialMode: mode }),

  // ── Persistence ────────────────────────────────────────────────────────────

  saveCurrentRoom: async () => {
    const {
      roomDimensions, detectedObjects,
      verifiedXAxis, verifiedYAxis, verifiedZAxis,
      spatialMode, currentRoomName: nameAtStart,
    } = get();

    // Auto-generate collision-proof name when none is set
    let roomName = get().currentRoomName;
    if (!roomName) {
      const date = new Date().toISOString().slice(0, 10);
      const hex4 = Math.random().toString(16).slice(2, 6);
      roomName = `Space-Scan-${date}-${hex4}`;
      if (typeof window !== "undefined") localStorage.setItem(ROOM_NAME_KEY, roomName);
      set({ currentRoomName: roomName });
    }

    if (!roomDimensions) {
      console.warn("[Persistence] saveCurrentRoom — missing roomDimensions, skipping");
      return;
    }

    // ── Compute spatial stats from digest ──────────────────────────────────
    const digest = get().spatialDigest;
    const floorArea = roomDimensions.floorArea ?? (roomDimensions.width * roomDimensions.length);
    const floorOccupancyPct = digest && floorArea > 0
      ? +(digest.inventory
          .filter((i) => i.tier === "primary" && i.width != null && i.depth != null)
          .reduce((s, i) => s + i.width! * i.depth!, 0) / floorArea * 100
        ).toFixed(1)
      : null;
    const tightestClearanceM = digest && digest.objectGaps.length > 0
      ? +Math.min(...digest.objectGaps.map((g) => g.gapMetres)).toFixed(3)
      : null;
    const maxWallAvailableM = digest && digest.wallClearances.length > 0
      ? +Math.max(...digest.wallClearances.map((w) => w.remaining)).toFixed(3)
      : null;

    const spatialStats: SpatialStatsPayload = {
      floor_occupancy_pct:  floorOccupancyPct,
      tightest_clearance_m: tightestClearanceM,
      max_wall_available_m: maxWallAvailableM,
    };
    const statsResult = SpatialStatsSchema.safeParse(spatialStats);

    // ── Validate room payload ──────────────────────────────────────────────
    const roomPayload = {
      name:                roomName,
      verified_dimensions: {
        width:  roomDimensions.width,
        length: roomDimensions.length,
        height: roomDimensions.height,
      },
      verified_x_axis: verifiedXAxis  ?? null,
      verified_y_axis: verifiedYAxis  ?? null,
      verified_z_axis: verifiedZAxis  ?? null,
      spatial_stats:   statsResult.success ? statsResult.data : undefined,
      spatial_mode:    spatialMode,
    };

    const roomResult = RoomSchema.safeParse(roomPayload);
    if (!roomResult.success) {
      console.error("[Spatial-Integrity-Error] Room validation failed:", roomResult.error.issues);
      return;
    }

    // ── Generate spatial summary + fetch embedding (graceful degradation) ──
    // The embedding enriches the room record for semantic search; if it fails
    // we still persist all spatial data — the vector can be backfilled later.
    let embedding: number[] | null = null;
    try {
      const resolvedName = get().currentRoomName ?? roomName;
      const summaryText = generateSpatialSummary(
        resolvedName, spatialMode, roomDimensions, detectedObjects,
      );
      const embedRes = await fetch("/api/embed", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ text: summaryText }),
      });
      if (embedRes.ok) {
        const embedBody = (await embedRes.json()) as { embedding?: number[] };
        if (Array.isArray(embedBody.embedding) && embedBody.embedding.length > 0) {
          embedding = embedBody.embedding;
          console.log(`[Embedding] ${embedding.length}-dim vector generated for "${resolvedName}"`);
        } else {
          console.warn("[Embedding] Unexpected shape — skipping:", embedBody);
        }
      } else {
        const errBody = await embedRes.json().catch(() => ({}));
        console.warn("[Embedding] API error — spatial data will still save:", errBody);
      }
    } catch (embedErr) {
      console.error("[Embedding] Fetch threw — spatial data will still save:", embedErr);
    }

    // ── Upsert room row (with embedding when available) ────────────────────
    // Convert the embedding array to a Postgres vector literal so the supabase
    // client sends a typed string rather than a bare JSON array, avoiding any
    // driver-level dimension or cast mismatch.
    const embeddingVector = embedding ? `[${embedding.join(",")}]` : null;

    if (embeddingVector) {
      console.log(
        `[Embedding] upsert payload — dims: ${embedding!.length}` +
        ` | first 5: [${embedding!.slice(0, 5).map((n) => n.toFixed(6)).join(", ")}]`,
      );
    }

    const upsertPayload = embeddingVector
      ? { ...roomResult.data, embedding: embeddingVector }
      : roomResult.data;

    const { data: roomData, error: roomError } = await supabase
      .from("rooms")
      .upsert(upsertPayload, { onConflict: "name" })
      .select("id")
      .single();

    if (roomError || !roomData) {
      console.error(
        "[Persistence] Room upsert failed:",
        roomError?.message,
        "| code:", roomError?.code,
        "| details:", roomError?.details,
        "| hint:", roomError?.hint,
      );
      return;
    }

    const roomId: string = roomData.id;
    set({ currentRoomId: roomId, currentRoomName: roomName, _vectorSynced: embedding !== null });

    // ── Build + validate entity payloads ───────────────────────────────────
    const validEntities: Array<{
      room_id: string; label: string; occupancy_tier: string;
      map: { x: number; z: number; w: number; d: number } | null;
      is_verified: boolean;
    }> = [];

    for (const o of detectedObjects) {
      const map = o.dimensions
        ? {
            x: +o.position3D[0].toFixed(3),
            z: +o.position3D[2].toFixed(3),
            w: +o.dimensions.width.toFixed(3),
            d: +o.dimensions.depth.toFixed(3),
          }
        : null;

      const entityResult = EntitySchema.safeParse({
        label:          o.name,
        occupancy_tier: classifyTier(o.name),
        map,
        is_verified:    o.isUserVerified ?? false,
      });

      if (!entityResult.success) {
        console.error(
          `[Spatial-Integrity-Error] Entity "${o.name}" failed validation:`,
          entityResult.error.issues,
        );
        continue;
      }

      validEntities.push({ room_id: roomId, ...entityResult.data });
    }

    if (validEntities.length === 0) return;

    // ── UPSERT entities (keyed on room_id + label) ─────────────────────────
    // UNIQUE(room_id, label) ensures each entity is upserted by identity,
    // never duplicated — safe for repeated saves of the same scan.
    const { error: entitiesError } = await supabase
      .from("spatial_entities")
      .upsert(validEntities, { onConflict: "room_id,label" });

    if (entitiesError) {
      console.error("[Persistence] Entities upsert failed:", entitiesError.message);
      return;
    }

    console.log(
      `[Persistence] Saved space "${roomName}" (id=${roomId}, mode=${spatialMode}) — ` +
      `${validEntities.length} entities, embedding=${embedding ? "✓ indexed" : "✗ skipped"}`,
    );
  },

  loadRoom: async (roomName: string) => {
    const { data, error } = await supabase
      .from("rooms")
      .select("*, spatial_entities(*)")
      .eq("name", roomName)
      .single();

    if (error || !data) {
      console.warn(`[Persistence] loadRoom "${roomName}" — not found:`, error?.message);
      return;
    }

    // ── Validate room record through Zod ───────────────────────────────────
    const roomResult = RoomSchema.safeParse({
      name:                data.name,
      verified_dimensions: data.verified_dimensions,
      verified_x_axis:     data.verified_x_axis  ?? null,
      verified_y_axis:     data.verified_y_axis  ?? null,
      verified_z_axis:     data.verified_z_axis  ?? null,
      spatial_mode:        data.spatial_mode     ?? undefined,
    });

    if (!roomResult.success) {
      console.error(
        "[Spatial-Integrity-Error] Loaded room failed Zod validation:",
        roomResult.error.issues,
      );
      return;
    }

    const vd   = roomResult.data.verified_dimensions;
    const vX   = roomResult.data.verified_x_axis ?? null;
    const vY   = roomResult.data.verified_y_axis ?? null;
    const vZ   = roomResult.data.verified_z_axis ?? null;
    const mode = roomResult.data.spatial_mode    ?? "room" as SpatialMode;

    const rawStats = (data as any).spatial_stats as Record<string, unknown> | null | undefined;
    const statsResult = rawStats ? SpatialStatsSchema.safeParse(rawStats) : null;
    const persistedStats = statsResult?.success
      ? {
          floorOccupancyPct:   statsResult.data.floor_occupancy_pct,
          tightestClearanceM:  statsResult.data.tightest_clearance_m,
          maxWallAvailableM:   statsResult.data.max_wall_available_m,
        }
      : null;

    // ── Validate + reconstruct entities ───────────────────────────────────
    const restoredObjects: DetectedObject[] = [];

    for (const raw of (data.spatial_entities ?? []) as unknown[]) {
      const result = EntitySchema.safeParse(raw);
      if (!result.success) {
        console.warn("[Persistence] Entity validation failed — skipping:", result.error.issues);
        continue;
      }
      const e = result.data;
      restoredObjects.push({
        uid:              `db_${e.label}_${Math.random().toString(36).slice(2, 8)}`,
        name:             e.label,
        position3D:       [e.map?.x ?? 0, 0, e.map?.z ?? 0] as Vector3Tuple,
        pixelCoords:      { x: 0, y: 0 },
        scanCount:        1,
        isUserVerified:   e.is_verified,
        isOpening:        e.occupancy_tier === "architectural",
        dimensions:       e.map
          ? { width: e.map.w, height: 0, depth: e.map.d }
          : undefined,
        rawMeshDimensions: e.map
          ? { width: e.map.w, height: 0, depth: e.map.d }
          : undefined,
      });
    }

    set({
      currentRoomId:   data.id,
      currentRoomName: roomName,
      verifiedXAxis:   vX,
      verifiedYAxis:   vY,
      verifiedZAxis:   vZ,
      spatialMode:     mode,
      roomDimensions:  { width: vd.width, length: vd.length, height: vd.height, floorArea: +(vd.width * vd.length).toFixed(2) },
      detectedObjects: restoredObjects,
      // Digest will be rebuilt on next sendMessage / scan
      spatialDigest:   null,
      _digestKey:      "",
      persistedStats,
    });

    console.log(
      `[Persistence] Hydrated space "${roomName}" (mode=${mode}) — ` +
      `${restoredObjects.length} entities, axes X=${vX} Y=${vY} Z=${vZ}`,
    );
  },

  resetForNewScan: () => {
    if (typeof window !== "undefined") localStorage.removeItem(ROOM_NAME_KEY);
    set({
      detectedObjects:     [],
      roomDimensions:      null,
      _baseMeshDimensions: null,
      verifiedXAxis:       null,
      verifiedYAxis:       null,
      verifiedZAxis:       null,
      verifiedScaleFactor: null,
      metricRatio:         null,
      globalScale:         { x: 1, y: 1, z: 1 },
      _rulerRatio:         null,
      currentRoomId:       null,
      currentRoomName:     null,
      spatialDigest:       null,
      _digestKey:          "",
      persistedStats:      null,
      _vectorSynced:       null as boolean | null,
      spatialMode:         "room" as SpatialMode,
      spatialDiagnostics:  null,
      aiMessage:           "",
      anchorLog:           [],
      pendingIsolationUIDs: [],
      ceilingHeightSource: "fallback",
    });
    console.log("[AeroPilot] Store reset for new scan.");
  },

  // ── Spatial Sandbox ──────────────────────────────────────────────────────────
  loadSandboxManifest: (manifest: SpatialManifest) => {
    if (manifest.schema !== "vista-spatial-manifest/v1") {
      console.warn("[Sandbox] Unknown manifest schema:", manifest.schema);
      return;
    }

    const room      = manifest.room;
    const effective = manifest.scale.effective;

    // Reconstruct DetectedObject[] — pixelCoords and scanCount are not stored in the
    // manifest; supply sensible defaults so downstream label / voxel code is satisfied.
    const restoredObjects: DetectedObject[] = manifest.objects.map((o) => ({
      uid:               o.uid,
      name:              o.name,
      position3D:        o.position,
      pixelCoords:       { x: 0, y: 0 },
      scanCount:         1,
      confidence:        o.confidence,
      dimensions:        o.dimensions,
      rawDimensions:     o.rawDimensions,
      rawMeshDimensions: o.rawDimensions, // best available substitute for the original mesh baseline
      isOpening:         o.isOpening,
      volumeAccuracy:    o.volumeAccuracy,
    }));

    const rd: RoomDimensions = {
      width:     room.width,
      length:    room.length,
      height:    room.height,
      floorArea: room.floorArea ?? +(room.width * room.length).toFixed(2),
    };

    const digest    = buildSpatialDigest(restoredObjects, rd);
    const digestKey = digestFingerprint(restoredObjects, rd);

    // Clear any persisted Scale Lock — the manifest's effective scale is the ground truth
    // and a locked factor from a previous session would silently override it.
    if (typeof window !== "undefined") localStorage.removeItem(LOCKED_SCALE_KEY);

    set({
      roomDimensions:      rd,
      autoScaleFactor:     manifest.scale.auto,
      verifiedScaleFactor: manifest.scale.verified,
      globalScale:         { x: effective, y: effective, z: effective },
      _lockedScale:        null,
      detectedObjects:     restoredObjects,
      spatialDiagnostics:  manifest.diagnostics,
      anchorLog:           [],
      spatialDigest:       digest,
      _digestKey:          digestKey,
      // Clear per-axis overrides — the manifest's effective scale is the ground truth
      verifiedYAxis:       null,
      verifiedXAxis:       null,
      verifiedZAxis:       null,
      metricRatio:         null,
      _rulerRatio:         null,
      _baseMeshDimensions: rd,
      ceilingHeightSource: "measured" as const,
      currentRoomName:     null,
      currentRoomId:       null,
      persistedStats:      null,
      _vectorSynced:       null as boolean | null,
    });

    console.log(
      `[Sandbox] Hydrated from manifest — room: ${room.width}×${room.length}×${room.height}m, ` +
      `${restoredObjects.length} object(s), effective scale=${effective}×`,
    );
  },

  // ── AI Chat ─────────────────────────────────────────────────────────────────

  sendMessage: async (userMessage: string) => {
    // ── 1. Check if the user wants to zoom into a detected object ──────────
    const { detectedObjects } = get();

    if (detectedObjects.length > 0) {
      const zoomMatch = userMessage.match(ZOOM_RE);
      if (zoomMatch) {
        const query = zoomMatch[1].toLowerCase().trim().replace(/[?.!,]/g, "");
        const found = detectedObjects.find(
          (o) =>
            o.name.toLowerCase().includes(query) ||
            query.includes(o.name.toLowerCase())
        );

        if (found) {
          const currentCamPos = get().cameraConfig.position;
          console.log(`[AeroPilot] Zooming into detected object: "${found.name}"`, found.position3D);
          set({
            cameraConfig: zoomConfig(found.position3D, currentCamPos),
            isMoving: true,
            aiMessage: `Focusing on the ${found.name}.`,
            isThinking: false,
          });
          return; // short-circuit — no API call needed
        }
      }
    }

    // ── 2. Normal room-navigation flow ─────────────────────────────────────
    set({ isThinking: true, aiMessage: "" });
    try {
      // ── Resilience Guard: emergency hydration when digest is absent ──────
      // If no spatial data is in memory but a persisted room record exists,
      // hydrate from Supabase before sending the message so the AI has context.
      {
        const { spatialDigest: sd, currentRoomId, currentRoomName, targetLocation } = get();
        if (!sd && (currentRoomId || currentRoomName)) {
          const hydrateFrom = currentRoomName ?? targetLocation;
          console.log(`[Persistence] Resilience Guard — emergency hydration for "${hydrateFrom}"`);
          await get().loadRoom(hydrateFrom);
        }
      }

      const { roomDimensions, spatialDigest, detectedObjects, _digestKey } = get();

      // ── Latency Guard: rebuild digest only if stale ─────────────────────
      let digest = spatialDigest;
      const freshKey = digestFingerprint(detectedObjects, roomDimensions);
      if (freshKey !== _digestKey) {
        digest = buildSpatialDigest(detectedObjects, roomDimensions);
        set({ spatialDigest: digest, _digestKey: freshKey });
      }

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userMessage,
          roomDimensions,
          spatialDigest:   digest,
          currentRoomName: get().currentRoomName,
          spatialMode:     get().spatialMode,
          globalScale:     get().globalScale,
          lockedScale:     get()._lockedScale,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        set({ aiMessage: body.error ?? "Something went wrong.", isThinking: false });
        return;
      }

      const body = (await res.json()) as { locationId: string; message: string };
      const rawId = body.locationId ?? "";
      const message = body.message ?? "";

      const locationId = normaliseId(rawId);
      const loc = locations[locationId];

      console.log(
        `[AeroPilot] API response → rawId: "${rawId}" | normalised: "${locationId}" | resolved: ${
          loc ? `"${loc.id}" ✓` : "NOT FOUND ✗"
        }`
      );

      if (loc) {
        set({
          targetLocation: loc.id,
          cameraConfig: freshConfig(loc.camera),
          isMoving: true,
          aiMessage: message,
          isThinking: false,
        });
      } else {
        // "current" means spatial Q&A — no navigation, just show the message.
        if (locationId !== "current") {
          console.warn(`[AeroPilot] Unknown locationId "${locationId}" — camera unchanged.`);
        }
        set({ aiMessage: message, isThinking: false });
      }
    } catch (err) {
      console.error("[AeroPilot] sendMessage error:", err);
      set({ aiMessage: "Failed to reach AeroPilot. Please try again.", isThinking: false });
    }
  },

  // ── Auto-Discovery ────────────────────────────────────────────────────────
  detectedObjects: loadCheckpoint(),
  scanCheckpoint: null,
  pendingScan: false,
  isScanning: false,
  isDeepScanning: false,
  deepScanProgress: 0,
  deepScanTotal: DEEP_SCAN_TOTAL,

  debugSnapshot: null,
  setDebugSnapshot: (url) => set({ debugSnapshot: url }),

  scanMode: "deep",
  setScanMode: (mode) => set({ scanMode: mode }),

  // ── Semantic Scale Calibration ────────────────────────────────────────────
  autoScaleFactor:     1.0,
  verifiedScaleFactor: null,
  metricRatio:         null,
  globalScale:         { x: 1, y: 1, z: 1 },
  anchorLog:           [],
  _lockedScale:        loadLockedScale(),

  setVerifiedScaleFactor: (factor) => {
    set({ verifiedScaleFactor: factor });
    const { detectedObjects, autoScaleFactor, metricRatio, _baseMeshDimensions,
            verifiedYAxis, verifiedXAxis, verifiedZAxis, _lockedScale } = get();
    const newGlobalScale = computeGlobalScale(
      _lockedScale,
      autoScaleFactor, factor, metricRatio, _baseMeshDimensions,
      verifiedYAxis, verifiedZAxis, verifiedXAxis,
    );
    set({ globalScale: newGlobalScale, detectedObjects: reapplyAndValidate(detectedObjects, newGlobalScale) });
  },

  setManualScale: (factor) => {
    if (typeof window !== "undefined") {
      if (factor != null) localStorage.setItem(LOCKED_SCALE_KEY, String(factor));
      else               localStorage.removeItem(LOCKED_SCALE_KEY);
    }
    set({ _lockedScale: factor });
    const { detectedObjects, autoScaleFactor, verifiedScaleFactor, metricRatio,
            _baseMeshDimensions, verifiedYAxis, verifiedXAxis, verifiedZAxis } = get();
    const newGlobalScale = computeGlobalScale(
      factor,                    // pass the new locked value directly (or null to unlock)
      autoScaleFactor, verifiedScaleFactor, metricRatio, _baseMeshDimensions,
      verifiedYAxis, verifiedZAxis, verifiedXAxis,
    );
    set({ globalScale: newGlobalScale, detectedObjects: reapplyAndValidate(detectedObjects, newGlobalScale) });
    if (factor != null) {
      console.log(`[ScaleLock] Scale locked at ${factor.toFixed(4)}× — subsequent scans will use this factor`);
    } else {
      console.log(`[ScaleLock] Scale unlocked — reverting to auto-computation`);
    }
  },

  setObjectVerifiedDimensions: (uid, dims) => {
    set((state) => ({
      detectedObjects: state.detectedObjects.map((o) =>
        o.uid === uid
          ? { ...o, isUserVerified: true, verifiedDimensions: dims, dimensions: dims }
          : o,
      ),
    }));
  },

  // ── Spatial Diagnostics ───────────────────────────────────────────────────
  spatialDiagnostics:       null,
  updateSpatialDiagnostics: (d) => set({ spatialDiagnostics: d }),

  // ── Manual Data Injection ─────────────────────────────────────────────────
  ceilingHeightSource: "fallback",
  _baseMeshDimensions: null,
  verifiedYAxis:       null,
  verifiedXAxis:       null,
  verifiedZAxis:       null,

  // ── Reference Ruler ───────────────────────────────────────────────────────
  rulerActive:  false,
  rulerPoints:  [] as Vector3Tuple[],
  _rulerRatio:  null,

  setVerifiedYAxis: (h) => {
    const { _baseMeshDimensions, verifiedXAxis, verifiedZAxis, _rulerRatio,
            autoScaleFactor, verifiedScaleFactor, detectedObjects, _lockedScale } = get();
    set({ verifiedYAxis: h, ceilingHeightSource: h != null ? "verified" : "fallback" });
    if (_baseMeshDimensions) {
      const newMetricRatio = deriveMetricRatio(_rulerRatio, _baseMeshDimensions, h, verifiedXAxis, verifiedZAxis);
      const newGlobalScale = computeGlobalScale(
        _lockedScale,
        autoScaleFactor, verifiedScaleFactor, newMetricRatio, _baseMeshDimensions,
        h, verifiedZAxis, verifiedXAxis,
      );
      set({
        metricRatio:     newMetricRatio,
        roomDimensions:  resolveRoomDimensions(_baseMeshDimensions, h, verifiedXAxis, verifiedZAxis),
        globalScale:     newGlobalScale,
        detectedObjects: reapplyAndValidate(detectedObjects, newGlobalScale),
      });
    }
    // Persist ground truth to cloud
    setTimeout(() => get().saveCurrentRoom().catch((err) =>
      console.error("[Persistence] Auto-save (axis verified) failed:", err)
    ), 0);
  },

  setVerifiedXAxis: (v) => {
    const { _baseMeshDimensions, verifiedYAxis, verifiedZAxis, _rulerRatio,
            autoScaleFactor, verifiedScaleFactor, detectedObjects, _lockedScale } = get();
    set({ verifiedXAxis: v });
    if (_baseMeshDimensions) {
      const newMetricRatio = deriveMetricRatio(_rulerRatio, _baseMeshDimensions, verifiedYAxis, v, verifiedZAxis);
      const newGlobalScale = computeGlobalScale(
        _lockedScale,
        autoScaleFactor, verifiedScaleFactor, newMetricRatio, _baseMeshDimensions,
        verifiedYAxis, verifiedZAxis, v,
      );
      set({
        metricRatio:     newMetricRatio,
        roomDimensions:  resolveRoomDimensions(_baseMeshDimensions, verifiedYAxis, v, verifiedZAxis),
        globalScale:     newGlobalScale,
        detectedObjects: reapplyAndValidate(detectedObjects, newGlobalScale),
      });
    }
    // Persist ground truth to cloud
    setTimeout(() => get().saveCurrentRoom().catch((err) =>
      console.error("[Persistence] Auto-save (axis verified) failed:", err)
    ), 0);
  },

  setVerifiedZAxis: (v) => {
    const { _baseMeshDimensions, verifiedYAxis, verifiedXAxis, _rulerRatio,
            autoScaleFactor, verifiedScaleFactor, detectedObjects, _lockedScale } = get();
    set({ verifiedZAxis: v });
    if (_baseMeshDimensions) {
      const newMetricRatio = deriveMetricRatio(_rulerRatio, _baseMeshDimensions, verifiedYAxis, verifiedXAxis, v);
      const newGlobalScale = computeGlobalScale(
        _lockedScale,
        autoScaleFactor, verifiedScaleFactor, newMetricRatio, _baseMeshDimensions,
        verifiedYAxis, v, verifiedXAxis,
      );
      set({
        metricRatio:     newMetricRatio,
        roomDimensions:  resolveRoomDimensions(_baseMeshDimensions, verifiedYAxis, verifiedXAxis, v),
        globalScale:     newGlobalScale,
        detectedObjects: reapplyAndValidate(detectedObjects, newGlobalScale),
      });
    }
    // Persist ground truth to cloud
    setTimeout(() => get().saveCurrentRoom().catch((err) =>
      console.error("[Persistence] Auto-save (axis verified) failed:", err)
    ), 0);
  },

  // ── Reference Ruler ───────────────────────────────────────────────────────
  setRulerActive: (active) => set({ rulerActive: active, rulerPoints: active ? [] : get().rulerPoints }),

  addRulerPoint: (pt) => {
    const { rulerPoints } = get();
    // Third click resets to a fresh first point so the user can re-measure.
    set({ rulerPoints: rulerPoints.length >= 2 ? [pt] : [...rulerPoints, pt] });
  },

  clearRuler: () => set({ rulerActive: false, rulerPoints: [] }),

  commitRulerRatio: (threejsDist, realMetres) => {
    if (threejsDist <= 0 || realMetres <= 0) return;
    const newRulerRatio = +(realMetres / threejsDist).toFixed(4);
    const { _baseMeshDimensions, verifiedYAxis, verifiedXAxis, verifiedZAxis,
            autoScaleFactor, verifiedScaleFactor, detectedObjects, _lockedScale } = get();
    const newMetricRatio = deriveMetricRatio(newRulerRatio, _baseMeshDimensions, verifiedYAxis, verifiedXAxis, verifiedZAxis);
    const newGlobalScale = computeGlobalScale(
      _lockedScale,
      autoScaleFactor, verifiedScaleFactor, newMetricRatio, _baseMeshDimensions,
      verifiedYAxis, verifiedZAxis, verifiedXAxis,
    );
    console.log(
      `[ScaleSync] Ruler committed: ${realMetres} m / ${threejsDist.toFixed(4)} units → ` +
      `metricRatio=${newMetricRatio?.toFixed(4)}`
    );
    set({
      _rulerRatio:     newRulerRatio,
      metricRatio:     newMetricRatio,
      globalScale:     newGlobalScale,
      detectedObjects: reapplyAndValidate(detectedObjects, newGlobalScale),
      rulerActive:     false,
      rulerPoints:     [],
    });
  },

  // ── Voxel Isolation ───────────────────────────────────────────────────────
  pendingIsolationUIDs: [],

  queueVoxelIsolation: (uid) => {
    set((s) => ({
      pendingIsolationUIDs: s.pendingIsolationUIDs.includes(uid)
        ? s.pendingIsolationUIDs
        : [...s.pendingIsolationUIDs, uid],
    }));
  },

  resolveVoxelIsolation: (uid, newDims) => {
    const { detectedObjects, globalScale, pendingIsolationUIDs } = get();
    const updatedUIDs = pendingIsolationUIDs.filter((id) => id !== uid);
    const obj = detectedObjects.find((o) => o.uid === uid);

    if (!newDims || !obj) {
      set({ pendingIsolationUIDs: updatedUIDs });
      return;
    }

    // ── Point 2: Geometric Invariance ─────────────────────────────────────────
    // rawMeshDimensions MUST be in the unscaled (1.0×) coordinate space so that
    // reapplyScale(rawMesh × globalScale) always produces the correct calibrated
    // value regardless of when the isolation ran.
    // ScanBridge passes raw Three.js world-unit dims; we normalise here so this
    // invariant is enforced at a single, authoritative call-site.
    const gx = Math.max(globalScale.x, 0.01);
    const gy = Math.max(globalScale.y, 0.01);
    const gz = Math.max(globalScale.z, 0.01);
    const rawDims = {
      width:  +(newDims.width  / gx).toFixed(3),
      height: +(newDims.height / gy).toFixed(3),
      depth:  +(newDims.depth  / gz).toFixed(3),
    };

    // Only accept the isolation result when it produced a strictly smaller footprint
    // (compare against the current displayed/calibrated dims, not raw units).
    const prevW = obj.dimensions?.width  ?? Infinity;
    const prevD = obj.dimensions?.depth  ?? Infinity;
    const calibW = +(rawDims.width  * gx).toFixed(3);
    const calibD = +(rawDims.depth  * gz).toFixed(3);
    if (calibW >= prevW && calibD >= prevD) {
      console.log(`[AeroPilot] Voxel Isolation "${obj.name}" — no improvement, keeping original`);
      set({ pendingIsolationUIDs: updatedUIDs });
      return;
    }

    // ── Point 4: Awareness-Audit log ──────────────────────────────────────────
    const meshVol  = +(rawDims.width  * rawDims.height  * rawDims.depth ).toFixed(4);
    const calibVol = +(calibW * (rawDims.height * gy) * calibD).toFixed(4);
    console.log(
      `[Awareness-Audit] UID: ${uid} | Mesh Vol: ${meshVol} m³ | Real World Vol: ${calibVol} m³`
    );
    console.log(
      `[AeroPilot] Voxel Isolation resolved "${obj.name}" (uid=${uid}): ` +
      `${prevW.toFixed(3)}×${prevD.toFixed(3)}m → ${calibW}×${calibD}m (raw: ${rawDims.width}×${rawDims.depth})`
    );

    const calibratedDims   = applyScaleVector(rawDims, globalScale);
    const updatedObjects   = detectedObjects.map((o) =>
      o.uid !== uid ? o : {
        ...o,
        rawMeshDimensions: rawDims,
        dimensions:        calibratedDims,
        scaleValidation:   undefined,
        scaleConflictMsg:  undefined,
      }
    );

    // Rebuild digest — object footprint just changed
    const { roomDimensions: rd, _digestKey: dk } = get();
    const digestUpdate = rebuildDigestIfChanged(updatedObjects, rd, dk);

    set({
      pendingIsolationUIDs: updatedUIDs,
      detectedObjects:      updatedObjects,
      ...(digestUpdate.spatialDigest ? digestUpdate : {}),
    });
  },

  // ── Floor Snap ────────────────────────────────────────────────────────────
  pendingFloorSnap: false,
  triggerFloorSnap: () => set({ pendingFloorSnap: true }),
  clearFloorSnap:   () => set({ pendingFloorSnap: false }),
  _gltfScene:       null,
  setGltfScene:     (obj) => set({ _gltfScene: obj }),

  // ── Export ────────────────────────────────────────────────────────────────
  exportSpatialManifest: () => {
    const {
      roomDimensions, autoScaleFactor, verifiedScaleFactor,
      anchorLog, spatialDiagnostics, detectedObjects,
    } = get();
    if (!roomDimensions) {
      console.warn("[AeroPilot] exportSpatialManifest — no roomDimensions yet");
      return;
    }
    const manifest = buildSpatialManifest(
      roomDimensions, autoScaleFactor, verifiedScaleFactor,
      anchorLog, spatialDiagnostics, detectedObjects,
    );
    const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `spatial-manifest-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  },

  // ── Cinematic Tour ────────────────────────────────────────────────────────
  isTouring:        false,
  tourIndex:        0,
  tourStops:        [],
  spatialClearance: null,

  setAiMessage: (msg) => set({ aiMessage: msg }),

  startTour: () => {
    const { detectedObjects, roomDimensions } = get();
    if (!roomDimensions) return;
    const tourStops = buildTourStops(roomDimensions, detectedObjects);
    if (tourStops.length === 0) return;
    const spatialClearance = computeSpatialClearance(roomDimensions, detectedObjects);
    const first = tourStops[0];
    set({
      isTouring:        true,
      tourIndex:        0,
      tourStops,
      spatialClearance,
      aiMessage:        "",
      cameraConfig:     freshConfig({ position: first.position, lookAt: first.lookAt }),
      isMoving:         true,
    });
  },

  stopTour: () => {
    set({ isTouring: false, tourIndex: 0, tourStops: [], spatialClearance: null, aiMessage: "" });
  },

  tourAdvance: () => {
    const { tourIndex, tourStops } = get();
    const nextIdx = tourIndex + 1;
    if (nextIdx >= tourStops.length) {
      get().stopTour();
      return;
    }
    const next = tourStops[nextIdx];
    set({
      tourIndex:    nextIdx,
      aiMessage:    "",
      cameraConfig: freshConfig({ position: next.position, lookAt: next.lookAt }),
      isMoving:     true,
    });
  },

  triggerScan: () => set({ pendingScan: true, isScanning: true }),

  triggerDeepScan: () => {
    const s = get();
    if (s.isDeepScanning || s.isScanning || s.isThinking) return;

    // Fire-and-forget async sequence; keeps the Zustand action signature `() => void`.
    (async () => {
      const steps = get().scanMode === "quick"
        ? DEEP_SCAN_STEPS.slice(0, 4)
        : DEEP_SCAN_STEPS;
      const total = steps.length;
      set({ isDeepScanning: true, deepScanProgress: 0, deepScanTotal: total });

      try {
        for (let i = 0; i < steps.length; i++) {
          const step = i + 1;
          console.log(`[AeroPilot] Deep scan step ${step}/${total} — moving camera`);

          // ── Move camera to this angle ─────────────────────────────────────
          // freshConfig ensures a new object reference → CameraRig re-renders
          // → settledRef.current resets to false → animation restarts.
          set({
            deepScanProgress: step,
            cameraConfig: freshConfig(steps[i]),
            isMoving: true,
          });

          // Wait for CameraRig to settle.
          await waitFor(() => !get().isMoving, DEEP_SCAN_STEP_TIMEOUT);
          console.log(`[AeroPilot] Deep scan step ${step} — camera settled, triggering scan`);

          // ── Capture + Vision API + Raycaster at this angle ────────────────
          set({ pendingScan: true, isScanning: true });
          await waitFor(() => !get().isScanning, DEEP_SCAN_STEP_TIMEOUT);
          console.log(`[AeroPilot] Deep scan step ${step} — scan complete`);
          saveCheckpoint(step, get().detectedObjects);
        }

        console.log(
          `[AeroPilot] Deep scan finished — ${get().detectedObjects.length} object(s) in memory`
        );
      } catch (err) {
        console.error("[AeroPilot] Deep scan failed:", err);
      } finally {
        set({ isDeepScanning: false, deepScanProgress: 0, deepScanTotal: DEEP_SCAN_TOTAL });
        clearCheckpoint();
      }
    })();
  },

  resolveScan: (incoming) => {
    const existing = get().detectedObjects;

    const merged = [...existing];

    /**
     * Confidence-weighted merge distance.
     *
     * High-confidence detections (> 95 %) are kept spatially distinct at 0.4 m —
     * the model is sure they are separate objects (e.g. a TV and a doorway both
     * detected in the same frame).
     *
     * Low-confidence detections get a 1.2 m radius so noisy, uncertain hits that
     * land near an existing anchor are absorbed rather than creating ghost duplicates.
     *
     * This replaces the former flat 1.5 m constant, which was merging confidently-
     * detected objects that happened to be close together (TV, door) while still
     * allowing noise at long range.
     */
    function mergeThreshold(confA: number, confB: number): number {
      return Math.max(confA, confB) > 0.95 ? 0.4 : 1.2;
    }
    /** Minimum confidence to accept an incoming detection. */
    const CONFIDENCE_THRESHOLD = 0.8;

    /**
     * Class-family regexes for cross-class conflict detection.
     *
     * PRIMARY_FURNITURE — high-classWeight objects that define the scale ground truth.
     * ARCHITECTURAL     — structural openings with highly variable apparent sizes.
     *
     * When these two families are detected in overlapping space (Nook Conflict),
     * they must be kept as distinct inventory layers.  Their centroids and
     * dimensions must NEVER be averaged together — doing so would let a doorway's
     * inflated geometry stretch a bed's measurement.
     *
     * Scale priority: PRIMARY_FURNITURE classWeight (1.0) >> ARCHITECTURAL (0.1),
     * so the bed/sofa dominates computeScaleFactor automatically.
     */
    const PRIMARY_FURNITURE_RE = /\b(bed|sofa|couch|sectional|loveseat|dining\s+table)\b/i;
    const ARCHITECTURAL_RE     = /\b(door(?:way)?|entry|window|archway|arch)\b/i;

    /** True when nameA and nameB belong to opposing class families. */
    function isCrossClass(nameA: string, nameB: string): boolean {
      const aFurniture = PRIMARY_FURNITURE_RE.test(nameA);
      const bFurniture = PRIMARY_FURNITURE_RE.test(nameB);
      const aArch      = ARCHITECTURAL_RE.test(nameA);
      const bArch      = ARCHITECTURAL_RE.test(nameB);
      return (aFurniture && bArch) || (aArch && bFurniture);
    }

    /** Labels that imply a footprint ≥ 1.0 m². */
    const LARGE_FOOTPRINT_RE = /bed|sofa|couch|rug|carpet|sectional|loveseat|mattress/i;
    /** Below this footprint (width × depth, m²) a large-label object is flagged as a conflict. */
    const LARGE_FOOTPRINT_MIN = 1.0;

    /** Compute sizeConflict: large label but still under-sized footprint. */
    function checkSizeConflict(name: string, dimensions?: { width: number; height: number; depth: number }): boolean {
      if (!LARGE_FOOTPRINT_RE.test(name)) return false;
      if (!dimensions) return false;
      const footprint = dimensions.width * dimensions.depth;
      return footprint > 0 && footprint < LARGE_FOOTPRINT_MIN;
    }

    /**
     * Volume fill-ratio score: (solid voxels / bounding-box voxels) × 100, capped at 99.
     * VOXEL_SIZE = 0.1 m → voxels per axis = dim / 0.1
     */
    function computeVolumeAccuracy(
      voxelCount: number | undefined,
      dimensions: { width: number; height: number; depth: number } | undefined,
    ): number | undefined {
      if (!voxelCount || !dimensions) return undefined;
      const wv = Math.max(1, Math.round(dimensions.width  / 0.1));
      const hv = Math.max(1, Math.round(dimensions.height / 0.1));
      const dv = Math.max(1, Math.round(dimensions.depth  / 0.1));
      const bboxVox = wv * hv * dv;
      return Math.min(99, Math.round((voxelCount / bboxVox) * 100));
    }

    /**
     * Canonical name for semantic synonyms — detections in this map are merged
     * into the canonical key before name-matching, so "couch" and "loveseat"
     * land on an existing "sofa" marker instead of creating duplicates.
     */
    const SYNONYM_MAP: Record<string, string> = {
      couch:      "sofa",
      loveseat:   "sofa",
      settee:     "sofa",
      sectional:  "sofa",
      television: "tv",
      telly:      "tv",
      "center table":  "coffee table",
      "centre table":  "coffee table",
      "side table":    "end table",
      "night stand":   "nightstand",
      "night table":   "nightstand",
    };
    const canonical = (name: string) => {
      const lower = name.toLowerCase().trim();
      return SYNONYM_MAP[lower] ?? lower;
    };

    for (const det of incoming) {
      // ── Confidence gate — discard low-confidence detections ─────────────────
      const detConf = det.confidence ?? 1; // treat missing as max (legacy compat)
      if (detConf < CONFIDENCE_THRESHOLD) {
        console.log(
          `[AeroPilot] ✗ Discarded "${det.name}" — confidence ${detConf.toFixed(2)} < ${CONFIDENCE_THRESHOLD}`
        );
        continue;
      }

      const normName  = det.name.toLowerCase().trim();
      const canonName = canonical(normName);

      // ── 1. Canonical-name match — synonyms collapse onto the stored label ───
      // e.g. incoming "couch" → canonical "sofa" → matches stored "sofa"
      let idx = merged.findIndex((o) => canonical(o.name.toLowerCase().trim()) === canonName);

      // ── 2. Proximity match — catches semantic synonyms ("sofa" / "couch") ──
      // Only applied when no name match found, so a new synonym for a nearby
      // object merges into the existing marker rather than creating a duplicate.
      //
      // Cross-class guard: if the proximity candidate is a different class family
      // (PRIMARY_FURNITURE vs ARCHITECTURAL), block the merge entirely.  A bed in a
      // doorway nook must remain a distinct inventory layer — merging them would
      // average their positions and let doorway geometry inflate the bed's dimensions.
      if (idx === -1) {
        const [nx, ny, nz] = det.position3D;
        const proxIdx = merged.findIndex((o) => {
          const [ox, oy, oz] = o.position3D;
          const dx = ox - nx, dy = oy - ny, dz = oz - nz;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
          return dist < mergeThreshold(detConf, o.confidence ?? 0);
        });

        if (proxIdx !== -1) {
          if (isCrossClass(det.name, merged[proxIdx].name)) {
            // Nook Conflict — refuse proximity merge, keep as separate layers.
            const [ox, oy, oz] = merged[proxIdx].position3D;
            const [px, py, pz] = det.position3D;
            const dist = Math.sqrt(
              (ox - px) ** 2 + (oy - py) ** 2 + (oz - pz) ** 2,
            ).toFixed(2);
            console.warn(
              `[AeroPilot] ⚠ Nook Conflict (proximity blocked): ` +
              `"${det.name}" and "${merged[proxIdx].name}" are ${dist}m apart ` +
              `but belong to opposing class families (Primary Furniture vs Architectural). ` +
              `Keeping as distinct layers — dimensions will NOT be averaged. ` +
              `Primary furniture retains Scale priority (classWeight 1.0 vs 0.1).`,
            );
            // idx stays -1 → new object branch below creates a fresh entry
          } else {
            idx = proxIdx;
            const thresh = mergeThreshold(detConf, merged[idx].confidence ?? 0);
            console.log(
              `[AeroPilot] Proximity merge: "${det.name}" → "${merged[idx].name}" ` +
              `(threshold=${thresh} m, confs: ${detConf.toFixed(2)}/${(merged[idx].confidence ?? 0).toFixed(2)})`,
            );
          }
        }
      }

      if (idx !== -1) {
        const prev = merged[idx];
        const n = prev.scanCount;

        // ── Label smoothing: rename only when incoming confidence beats stored ─
        const prevConf = prev.confidence ?? 0;
        const winnerName = detConf > prevConf ? det.name : prev.name;
        if (winnerName !== prev.name) {
          console.log(
            `[AeroPilot] Label update: "${prev.name}" → "${winnerName}" ` +
            `(conf ${prevConf.toFixed(2)} → ${detConf.toFixed(2)})`
          );
        }

        // ── Sensor fusion: weighted average of position ──────────────────────
        // Dimensions and voxelCount come from the higher-confidence scan
        // (better view angle = better volumetric measurement).
        const useIncoming = detConf >= prevConf;
        const fusedDimensions = useIncoming
          ? (det.dimensions  ?? prev.dimensions)
          : (prev.dimensions ?? det.dimensions);
        const fusedVoxelCount = useIncoming
          ? (det.voxelCount  ?? prev.voxelCount)
          : (prev.voxelCount ?? det.voxelCount);

        const fusedIsOpening     = det.isOpening ?? prev.isOpening ?? false;
        const fusedSizeConflict  = fusedIsOpening ? false : checkSizeConflict(winnerName, fusedDimensions);
        const fusedVolumeAccuracy = fusedIsOpening ? undefined : computeVolumeAccuracy(fusedVoxelCount, fusedDimensions);
        // rawDimensions: preserve the higher-confidence scan's voxel measurement.
        // det.dimensions is always the fresh voxel output (pre-scale); prev.rawDimensions
        // is the last preserved raw reading.
        const rawDimensions = useIncoming
          ? (det.dimensions ?? prev.rawDimensions)
          : (prev.rawDimensions ?? det.dimensions);

        const fused: DetectedObject = {
          ...prev,
          name: winnerName,
          position3D: [
            (prev.position3D[0] * n + det.position3D[0]) / (n + 1),
            (prev.position3D[1] * n + det.position3D[1]) / (n + 1),
            (prev.position3D[2] * n + det.position3D[2]) / (n + 1),
          ],
          pixelCoords: det.pixelCoords,
          scanCount: n + 1,
          confidence: Math.max(prevConf, detConf),
          rawDimensions,
          // rawMeshDimensions: captured ONCE on first detection — never overwritten.
          // This is the immutable voxel baseline that drives displayedDimensions = rawMesh × globalScale.
          rawMeshDimensions: prev.rawMeshDimensions ?? det.dimensions,
          dimensions: fusedDimensions, // will be replaced by scale pass below
          voxelCount: fusedVoxelCount,
          sizeConflict: fusedSizeConflict,
          volumeAccuracy: fusedVolumeAccuracy,
          isOpening: fusedIsOpening || undefined,
        };
        if (fusedSizeConflict) {
          const fp = (fusedDimensions?.width ?? 0) * (fusedDimensions?.depth ?? 0);
          console.warn(
            `[AeroPilot] ⚠ SIZE CONFLICT "${fused.name}" — footprint=${fp.toFixed(2)} m² < ${LARGE_FOOTPRINT_MIN} m² — needs re-scan`
          );
        }
        merged[idx] = fused;
        console.log(
          `[AeroPilot] Fused "${fused.name}" (scan #${n + 1}) → ` +
          `(${fused.position3D[0].toFixed(2)}, ${fused.position3D[1].toFixed(2)}, ${fused.position3D[2].toFixed(2)})`
        );
      } else {
        // ── New object — assign stable UID ───────────────────────────────────
        const uid = crypto.randomUUID();
        const newIsOpening      = det.isOpening ?? false;
        const newSizeConflict   = newIsOpening ? false : checkSizeConflict(det.name, det.dimensions);
        const newVolumeAccuracy = newIsOpening ? undefined : computeVolumeAccuracy(det.voxelCount, det.dimensions);
        if (newSizeConflict) {
          const fp = (det.dimensions?.width ?? 0) * (det.dimensions?.depth ?? 0);
          console.warn(
            `[AeroPilot] ⚠ SIZE CONFLICT "${det.name}" — footprint=${fp.toFixed(2)} m² < ${LARGE_FOOTPRINT_MIN} m² — needs re-scan`
          );
        }
        merged.push({ ...det, uid, scanCount: 1, confidence: detConf, sizeConflict: newSizeConflict, volumeAccuracy: newVolumeAccuracy, isOpening: newIsOpening || undefined, rawDimensions: det.dimensions, rawMeshDimensions: det.dimensions });
        console.log(`[AeroPilot] New object "${det.name}" uid=${uid} conf=${detConf.toFixed(2)}`);
      }
    }

    // ── Nook Conflict audit ────────────────────────────────────────────────────
    // Scan the fully-merged inventory for cross-class pairs whose centroids are
    // within NOOK_DISTANCE_M.  These are objects that legitimately coexist in the
    // same physical nook (e.g. a bed pushed into a doorway alcove).  Both entries
    // remain in the inventory; this pass only logs the conflict so the user and
    // the AI are aware of the spatial overlap.
    const NOOK_DISTANCE_M = 0.5;
    for (let i = 0; i < merged.length; i++) {
      for (let j = i + 1; j < merged.length; j++) {
        const a = merged[i], b = merged[j];
        if (!isCrossClass(a.name, b.name)) continue;
        const [ax, ay, az] = a.position3D;
        const [bx, by, bz] = b.position3D;
        const dist = Math.sqrt((ax - bx) ** 2 + (ay - by) ** 2 + (az - bz) ** 2);
        if (dist < NOOK_DISTANCE_M) {
          const primaryName = PRIMARY_FURNITURE_RE.test(a.name) ? a.name : b.name;
          const archName    = ARCHITECTURAL_RE.test(a.name)     ? a.name : b.name;
          console.warn(
            `[AeroPilot] ⚠ Nook Conflict: "${primaryName}" and "${archName}" ` +
            `centroids are ${dist.toFixed(2)} m apart (< ${NOOK_DISTANCE_M} m threshold). ` +
            `Both retained as distinct layers. ` +
            `"${primaryName}" (classWeight 1.0) takes Scale priority over ` +
            `"${archName}" (classWeight 0.1) in computeScaleFactor.`,
          );
        }
      }
    }

    // ── Semantic scale pass ────────────────────────────────────────────────────
    // 1. Compute the auto (uniform) factor from high-confidence semantic anchors —
    //    UNLESS the user has provided a verified axis (Point 3: Heuristic Sanity Guard).
    //    When any verifiedAxis is active, the room geometry IS the ground truth.
    //    Letting the AI re-derive a competing factor from semantic anchors would
    //    corrupt the user's calibration, so computeScaleFactor is skipped entirely.
    // 2. Derive the per-axis globalScale vector — per-axis overrides take precedence
    //    when the user has injected verified room dimensions.
    // 3. Apply globalScale via reapplyScale:
    //    displayedDimensions = rawMeshDimensions × globalScale  (per object).
    //    Objects with isUserVerified + verifiedDimensions bypass global scale entirely.
    const { verifiedScaleFactor, metricRatio, _baseMeshDimensions, _rulerRatio,
            verifiedYAxis, verifiedXAxis, verifiedZAxis, _lockedScale } = get();
    const hasVerifiedAxis = verifiedXAxis != null || verifiedYAxis != null || verifiedZAxis != null;
    // When the scale is locked, skip semantic anchor computation entirely — the
    // locked factor IS the ground truth and nothing from the scan should change it.
    const scaleResult = (_lockedScale != null || hasVerifiedAxis)
      ? { factor: get().autoScaleFactor, matches: get().anchorLog, rawDepthOverrides: new Map<string, number>() }
      : computeScaleFactor(merged, STANDARD_ANCHORS, _baseMeshDimensions?.height ?? undefined, get().roomDimensions ?? undefined);
    const autoFactor  = scaleResult.factor;
    // Re-derive metricRatio in case new anchors nudged the average.
    const newMetricRatio = deriveMetricRatio(_rulerRatio, _baseMeshDimensions, verifiedYAxis, verifiedXAxis, verifiedZAxis) ?? metricRatio;
    const newGlobalScale = computeGlobalScale(
      _lockedScale,
      autoFactor, verifiedScaleFactor, newMetricRatio, _baseMeshDimensions,
      verifiedYAxis, verifiedZAxis, verifiedXAxis,
    );
    // Apply geometric scaling, then Hybrid Validation, then Structural Stack Merge
    // depth overrides.  The overrides replace the bed's scaled depth with
    // maxStackRawDepth × gs.z so the true rectangular platform footprint is used.
    const scaledMerged = applyRawDepthOverrides(
      reapplyAndValidate(merged, newGlobalScale),
      scaleResult.rawDepthOverrides,
      newGlobalScale,
    );

    console.log(
      `[AeroPilot] Scan complete — ${incoming.length} incoming, ${scaledMerged.length} total. ` +
      `globalScale=(X:${newGlobalScale.x.toFixed(4)} Y:${newGlobalScale.y.toFixed(4)} Z:${newGlobalScale.z.toFixed(4)}) ` +
      `auto=${autoFactor.toFixed(4)} verified=${verifiedScaleFactor ?? "none"}`
    );
    set({
      pendingScan:     false,
      isScanning:      false,
      detectedObjects: scaledMerged,
      autoScaleFactor: autoFactor,
      metricRatio:     newMetricRatio,
      globalScale:     newGlobalScale,
      anchorLog:       scaleResult.matches,
    });

    // ── Sanity Guard — queue objects that exceeded their sanityMax for targeted voxel isolation
    const sanityTriggers = collectSanityTriggers(scaledMerged, get().pendingIsolationUIDs);
    if (sanityTriggers.length > 0) {
      set((s) => ({ pendingIsolationUIDs: [...s.pendingIsolationUIDs, ...sanityTriggers] }));
    }

    // ── Rebuild SpatialDigest now that objects are finalised ─────────────────
    const { roomDimensions: rd, _digestKey: dk } = get();
    const digestUpdate = rebuildDigestIfChanged(scaledMerged, rd, dk);
    if (digestUpdate.spatialDigest) set(digestUpdate);
  },
}));
