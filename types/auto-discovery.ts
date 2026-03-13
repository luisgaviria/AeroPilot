import { Vector3Tuple } from "three";

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
   */
  dimensions?: { width: number; height: number; depth: number };
  /**
   * Number of solid voxels in the cluster that produced `dimensions`.
   * Low values (< 30) indicate a sparse or partially-occluded scan.
   * 0 = radius-fallback or negative-space path was used.
   */
  voxelCount?: number;
}

/**
 * A freshly raycasted detection that hasn't been assigned a uid yet.
 * Produced by ScanBridge and passed to resolveScan() in the store.
 */
export type IncomingDetection = Omit<DetectedObject, "uid" | "scanCount">;

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
