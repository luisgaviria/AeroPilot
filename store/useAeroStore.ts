import { create } from "zustand";
import { Vector3Tuple } from "three";
import { locations } from "@/data/locations";
import { DetectedObject, IncomingDetection, TourStop } from "@/types/auto-discovery";
import type { RoomDimensions } from "@/utils/spatial";
import { computeScaleFactor, scaleDims, type AnchorMatch } from "@/utils/semanticScale";

const VERIFIED_SCALE_KEY = "vista_verified_scale";

function loadVerifiedScale(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(VERIFIED_SCALE_KEY);
    if (!raw) return null;
    const n = parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}

function saveVerifiedScale(v: number | null): void {
  if (typeof window === "undefined") return;
  try {
    if (v == null) localStorage.removeItem(VERIFIED_SCALE_KEY);
    else           localStorage.setItem(VERIFIED_SCALE_KEY, String(v));
  } catch {}
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
  setRoomDimensions: (dims: RoomDimensions | null) => void;

  // ── AI Chat ───────────────────────────────────────────────────────────────
  aiMessage: string;
  isThinking: boolean;
  sendMessage: (userMessage: string) => Promise<void>;
  clearHistory: () => void;

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
  /** Auto-computed scale factor derived from semantic anchors (1.0 = no correction). */
  scaleFactor: number;
  /**
   * "Tape Measure" manual override.  When set, takes precedence over scaleFactor.
   * Persisted to localStorage so it survives page reload.
   */
  verifiedScaleFactor: number | null;
  /** Per-anchor match log from the most recent scale computation. */
  anchorLog: AnchorMatch[];
  /** Set (or clear) the manual verified scale factor. */
  setVerifiedScaleFactor: (factor: number | null) => void;

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

/** Resolves once `predicate` returns true, or rejects after `timeout` ms. */
function waitFor(predicate: () => boolean, timeout = 25_000): Promise<void> {
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
  setRoomDimensions: (dims) => set({ roomDimensions: dims }),

  // ── AI Chat ───────────────────────────────────────────────────────────────
  aiMessage: "",
  isThinking: false,

  clearHistory: () => set({ aiMessage: "" }),

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
      const { roomDimensions, detectedObjects } = get();
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userMessage,
          roomDimensions,
          detectedObjects: detectedObjects.map((o) => ({
            name: o.name,
            position3D: o.position3D,
            confidence: o.confidence,
            dimensions: o.dimensions,
          })),
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
  scaleFactor:         1.0,
  verifiedScaleFactor: loadVerifiedScale(),
  anchorLog:           [],

  setVerifiedScaleFactor: (factor) => {
    saveVerifiedScale(factor);
    set({ verifiedScaleFactor: factor });
    // Re-apply scale to all existing objects immediately.
    const { detectedObjects, scaleFactor } = get();
    const effective = factor ?? scaleFactor;
    set({
      detectedObjects: detectedObjects.map((o) =>
        o.rawDimensions
          ? { ...o, dimensions: scaleDims(o.rawDimensions, effective) }
          : o,
      ),
    });
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

          // Wait for CameraRig to settle (distance threshold < 0.002).
          await waitFor(() => !get().isMoving);
          console.log(`[AeroPilot] Deep scan step ${step} — camera settled, triggering scan`);

          // ── Capture + Vision API + Raycaster at this angle ────────────────
          set({ pendingScan: true, isScanning: true });
          await waitFor(() => !get().isScanning);
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
      if (idx === -1) {
        const [nx, ny, nz] = det.position3D;
        idx = merged.findIndex((o) => {
          const [ox, oy, oz] = o.position3D;
          const dx = ox - nx, dy = oy - ny, dz = oz - nz;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
          return dist < mergeThreshold(detConf, o.confidence ?? 0);
        });
        if (idx !== -1) {
          const thresh = mergeThreshold(detConf, merged[idx].confidence ?? 0);
          console.log(
            `[AeroPilot] Proximity merge: "${det.name}" → "${merged[idx].name}" ` +
            `(threshold=${thresh} m, confs: ${detConf.toFixed(2)}/${(merged[idx].confidence ?? 0).toFixed(2)})`
          );
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
        merged.push({ ...det, uid, scanCount: 1, confidence: detConf, sizeConflict: newSizeConflict, volumeAccuracy: newVolumeAccuracy, isOpening: newIsOpening || undefined, rawDimensions: det.dimensions });
        console.log(`[AeroPilot] New object "${det.name}" uid=${uid} conf=${detConf.toFixed(2)}`);
      }
    }

    // ── Semantic scale pass ────────────────────────────────────────────────────
    // Compute auto scale factor from high-confidence anchors, then apply the
    // effective factor (verifiedScaleFactor takes precedence) to all objects.
    const scaleResult = computeScaleFactor(merged);
    const autoFactor  = scaleResult.factor;
    const { verifiedScaleFactor } = get();
    const effectiveFactor = verifiedScaleFactor ?? autoFactor;

    const scaledMerged = merged.map((o) =>
      o.rawDimensions
        ? { ...o, dimensions: scaleDims(o.rawDimensions, effectiveFactor) }
        : o,
    );

    console.log(`[AeroPilot] Scan complete — ${incoming.length} incoming, ${scaledMerged.length} total. Scale factor=${effectiveFactor.toFixed(4)} (auto=${autoFactor.toFixed(4)}, verified=${verifiedScaleFactor ?? "none"})`);
    set({ pendingScan: false, isScanning: false, detectedObjects: scaledMerged, scaleFactor: autoFactor, anchorLog: scaleResult.matches });
  },
}));
