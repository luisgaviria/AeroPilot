import { create } from "zustand";
import { Vector3Tuple } from "three";
import { locations } from "@/data/locations";
import { DetectedObject, IncomingDetection } from "@/types/auto-discovery";
import type { RoomDimensions } from "@/utils/spatial";

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

  // ── Auto-Discovery ────────────────────────────────────────────────────────
  detectedObjects: DetectedObject[];
  pendingScan: boolean;
  isScanning: boolean;
  isDeepScanning: boolean;
  deepScanProgress: number; // 1–8 during deep scan, 0 otherwise
  deepScanTotal: number;    // always 8
  triggerScan: () => void;
  triggerDeepScan: () => void;
  resolveScan: (incoming: IncomingDetection[]) => void;
  /** Annotated snapshot data-URL set after each scan for visual debugging. */
  debugSnapshot: string | null;
  setDebugSnapshot: (url: string | null) => void;
  /** Persisted scan progress — restored after page reload mid-deep-scan. */
  scanCheckpoint: { progress: number; detectedObjects: DetectedObject[] } | null;
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

  triggerScan: () => set({ pendingScan: true, isScanning: true }),

  triggerDeepScan: () => {
    const s = get();
    if (s.isDeepScanning || s.isScanning || s.isThinking) return;

    // Fire-and-forget async sequence; keeps the Zustand action signature `() => void`.
    (async () => {
      set({ isDeepScanning: true, deepScanProgress: 0 });

      try {
        for (let i = 0; i < DEEP_SCAN_STEPS.length; i++) {
          const step = i + 1;
          console.log(`[AeroPilot] Deep scan step ${step}/${DEEP_SCAN_TOTAL} — moving camera`);

          // ── Move camera to this angle ─────────────────────────────────────
          // freshConfig ensures a new object reference → CameraRig re-renders
          // → settledRef.current resets to false → animation restarts.
          set({
            deepScanProgress: step,
            cameraConfig: freshConfig(DEEP_SCAN_STEPS[i]),
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
        set({ isDeepScanning: false, deepScanProgress: 0 });
        clearCheckpoint();
      }
    })();
  },

  resolveScan: (incoming) => {
    const existing = get().detectedObjects;

    const merged = [...existing];

    /** Two objects within this distance (metres) are the same physical item. */
    const MERGE_DIST = 1.5;
    /** Minimum confidence to accept an incoming detection. */
    const CONFIDENCE_THRESHOLD = 0.8;

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
          return Math.sqrt(dx * dx + dy * dy + dz * dz) < MERGE_DIST;
        });
        if (idx !== -1) {
          console.log(
            `[AeroPilot] Proximity merge: "${det.name}" → "${merged[idx].name}" ` +
            `(within ${MERGE_DIST} m)`
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
          dimensions: fusedDimensions,
          voxelCount: fusedVoxelCount,
        };
        merged[idx] = fused;
        console.log(
          `[AeroPilot] Fused "${fused.name}" (scan #${n + 1}) → ` +
          `(${fused.position3D[0].toFixed(2)}, ${fused.position3D[1].toFixed(2)}, ${fused.position3D[2].toFixed(2)})`
        );
      } else {
        // ── New object — assign stable UID ───────────────────────────────────
        const uid = crypto.randomUUID();
        merged.push({ ...det, uid, scanCount: 1, confidence: detConf });
        console.log(`[AeroPilot] New object "${det.name}" uid=${uid} conf=${detConf.toFixed(2)}`);
      }
    }

    console.log(`[AeroPilot] Scan complete — ${incoming.length} incoming, ${merged.length} total.`);
    set({ pendingScan: false, isScanning: false, detectedObjects: merged });
  },
}));
