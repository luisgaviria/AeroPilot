import { Vector3Tuple } from "three";

/**
 * A single stop on the geometric/structural cinematic tour.
 *
 * `corner`  — a pre-calculated corner vantage looking toward the room's centre
 *             of mass.  Camera position and lookAt are fixed for the duration.
 *
 * `sweep`   — a horizontal pan across a spatial opening.  The camera stays at
 *             the same world position while the lookAt moves from the left edge
 *             of the gap to the right edge (two consecutive sweep stops per
 *             opening: phase "left" then "right").
 */
export type TourStop =
  | {
      kind: "corner";
      position: Vector3Tuple;
      lookAt: Vector3Tuple;
      /** 0-based index used for label "Vantage 1 / 2 / 3". */
      cornerIndex: number;
      /** Auto-advance duration in ms. */
      durationMs: number;
    }
  | {
      kind: "sweep";
      position: Vector3Tuple;
      lookAt: Vector3Tuple;
      /** Which edge of the gap we are currently aimed at. */
      sweepPhase: "left" | "right";
      /** Total measured span of the opening in metres. */
      openingWidth: number;
      /** Auto-advance duration in ms (shorter than corner stops). */
      durationMs: number;
    };

/**
 * A fully resolved spatial anchor — persisted in the store across all scans.
 * Once a DetectedObject has a uid it keeps its position in the scene forever.
 */
export interface DetectedObject {
  /** Stable identity — survives subsequent scans.  Never changes after creation. */
  uid: string;
  /** Human-readable label returned by Gemini (e.g. "couch", "dining table"). */
  name: string;
  /** World-space 3D coordinates.  Updated by sensor-fusion averaging on re-scan. */
  position3D: Vector3Tuple;
  /** Pixel coordinates from the scan in which this object was first detected. */
  pixelCoords: { x: number; y: number };
  /**
   * How many scans have contributed to position3D.
   * Used for the running weighted-average (sensor fusion):
   *   newPos = (oldPos * scanCount + incomingPos) / (scanCount + 1)
   */
  scanCount: number;
  /**
   * Highest Gemini confidence score (0–1) seen across all scans for this object.
   * Used for label smoothing: a new detection renames this object only when its
   * confidence exceeds the stored value.
   */
  confidence?: number;
  /**
   * Physical size of the object in metres, derived from:
   *   1. Raycasting the left/right and top/bottom pixel edges (for width/height), or
   *   2. The bounding box of the nearest scene mesh(es) as a fallback.
   *
   * This is the SCALE-CORRECTED value (rawDimensions × scaleFactor).
   * Use rawDimensions when you need the unmodified voxel measurement.
   */
  dimensions?: { width: number; height: number; depth: number };
  /**
   * Voxel-measured dimensions before semantic-anchor scale correction.
   * Updated to the higher-confidence reading on re-scan — used by the semantic
   * anchor engine to derive the global scale factor.
   * Undefined for objects loaded from a legacy checkpoint that pre-dates this field.
   */
  rawDimensions?: { width: number; height: number; depth: number };
  /**
   * Immutable voxel measurement captured on the FIRST detection of this object.
   * Never overwritten by subsequent scans.
   *
   * displayedDimensions = rawMeshDimensions × globalScale (per-axis).
   * This decouples calibration changes from the source measurement so that
   * adjusting the global scale never degrades measurement precision.
   */
  rawMeshDimensions?: { width: number; height: number; depth: number };
  /**
   * True when the owner has manually confirmed the exact real-world size of
   * this specific object (e.g. "this is a 40-inch dining table").
   * When set, globalScale is bypassed for this object and verifiedDimensions
   * are used directly as the displayed size.
   */
  isUserVerified?: boolean;
  /**
   * Owner-confirmed real-world dimensions in metres.
   * Only meaningful when isUserVerified is true.
   */
  verifiedDimensions?: { width: number; height: number; depth: number };
  /**
   * Number of solid voxels in the cluster that produced `dimensions`.
   * Low values (< 30) indicate a sparse or partially-occluded scan.
   * 0 = radius-fallback or negative-space path was used.
   */
  voxelCount?: number;
  /**
   * True when the label implies a large footprint (bed / sofa / rug) but the
   * measured footprint (width × depth) is still < 1.0 m² after the adaptive
   * refinement pass.  Surfaced as ⚠️ in the UI so the user knows to re-scan.
   */
  sizeConflict?: boolean;
  /**
   * Volume fill-ratio score (0–99).
   * Formula: (solid voxel count / bounding-box voxel count) × 100, capped at 99.
   * High values (> 85) indicate dense, well-measured geometry.
   * Low values (< 60) indicate a sparse or partially-visible cluster.
   * Undefined for openings (isOpening = true) — they are voids, not solid masses.
   */
  volumeAccuracy?: number;
  /**
   * True for doors, windows, and other openings measured by the negative-space
   * gap sweep rather than the solid-mass BFS engine.
   */
  isOpening?: boolean;
  /**
   * Result of the Hybrid Validation pass (run after geometric scaling).
   *
   * "high-confidence"  — geometric size agrees with the Semantic Standard within
   *                      15 %.  The displayed dimensions are a 70/30 blend of
   *                      room-geometry scale and the semantic standard.
   * "scale-conflict"   — sizes diverge > 15 %.  Geometric size is kept unchanged;
   *                      the conflict is surfaced in the Diagnostic Dashboard.
   *
   * Undefined for objects with no matching entry in standardAnchors.ts or when
   * only semantic-anchor (no room-dimension) scaling is in effect.
   */
  scaleValidation?: "high-confidence" | "scale-conflict";
  /**
   * Human-readable measurement description set when scaleValidation === "scale-conflict".
   * Example: "Geometric 3'10\" vs standard 3'2\""
   */
  scaleConflictMsg?: string;
}

/**
 * A freshly raycasted detection that hasn't been assigned a uid yet.
 * Produced by ScanBridge and passed to resolveScan() in the store.
 */
export type IncomingDetection = Omit<DetectedObject, "uid" | "scanCount">;

/**
 * A single scan snapshot with Gemini's detected objects, saved for the
 * Visual Debugger so the dashboard can overlay bounding boxes and anchor pins.
 */
export interface ScanSnapshot {
  /** Pass label: "pass1", "pass2", "deep-1", "refinement", etc. */
  label:      string;
  /** Full data URL (data:image/jpeg;base64,...) for display. */
  dataUrl:    string;
  /** MIME type of the image. */
  mimeType:   string;
  /** Original pixel width of the captured snapshot. */
  width:      number;
  /** Original pixel height of the captured snapshot. */
  height:     number;
  /** Gemini-detected objects with bounding box pixel coords for overlay drawing. */
  objects:    VisionObject[];
  /** Names of the two objects used as the scale anchor for this pass, if any. */
  anchorObjects?: [string, string];
}

/** Raw shape returned by the Vision API endpoint before raycasting. */
export interface VisionObject {
  name: string;
  /** Pixel X of the visible CENTER of the object. */
  x: number;
  /** Pixel Y of the visible CENTER of the object. */
  y: number;
  /** Gemini confidence that the identification is correct (0.0–1.0). */
  confidence: number;
  /** Pixel X of the left-most visible edge — used for 3D width measurement. */
  xLeft?: number;
  /** Pixel X of the right-most visible edge — used for 3D width measurement. */
  xRight?: number;
  /** Pixel Y of the top-most visible edge — used for 3D height measurement. */
  yTop?: number;
  /** Pixel Y of the bottom-most visible edge — used for 3D height measurement. */
  yBottom?: number;
}
