/**
 * SpatialDigest — pre-computed spatial summary sent to the chat API.
 *
 * Built client-side from calibrated object dimensions after every scan or
 * voxel-isolation resolution.  Replaces the raw xRange/zRange object list to
 * reduce LLM token usage and eliminate in-prompt arithmetic.
 */

export interface GapEntry {
  /** Names of the two objects bounding this gap. */
  between: [string, string];
  /** Gap in metres.  Negative means the footprints overlap. */
  gapMetres: number;
  /** Which axis the gap runs along. */
  axis: "x" | "z";
  /** Human-readable label (already includes ft/in). */
  label: string;
}

export interface WallClearance {
  wall: "north" | "south" | "east" | "west";
  /** Free metres remaining after subtracting all objects placed against this wall. */
  remaining: number;
  /** True when remaining < 0.3 m. */
  atCapacity: boolean;
  /**
   * True when the raw remaining space was < 0.15 m — the 15 cm Wall Rule clamps
   * this to 0.0 m and sets this flag so the AI and UI treat the furniture as
   * flush with the wall rather than reporting a meaningless sub-threshold gap.
   */
  isTouchingWall?: boolean;
  /** Human-readable label. */
  label: string;
}

export interface PathBlockage {
  door: string;
  blocked: boolean;
  obstruction?: string;
  /** Minimum corridor clearance in metres. */
  pathClearance: number;
  /** Human-readable label. */
  label: string;
}

/**
 * Occupancy tier — controls whether an object participates in clearance
 * calculations or is reported as inventory-only.
 *
 *  primary      — solid volumes (sofa, bed, table, wardrobe …)
 *                 Used in gap AND inventory calculations.
 *  secondary    — surface overlays and soft furnishings (rug, curtain, lamp …)
 *                 Reported in inventory only; excluded from gap calculations
 *                 so a rug measurement never pollutes sofa clearance.
 *  architectural — fixed openings (door, window, archway)
 *                 Used only for path-blockage and wall-span; never in object gaps.
 */
export type OccupancyTier = "primary" | "secondary" | "architectural";

/** One entry in the full room inventory — every detected object appears here. */
export interface ObjectInventoryEntry {
  name:        string;
  tier:        OccupancyTier;
  width?:      number;   // calibrated metres
  height?:     number;
  depth?:      number;
  /** True when the scan engine has not yet measured this object's footprint. */
  pendingScan: boolean;
  /**
   * Low-resolution spatial map — calibrated centre + footprint size.
   * Present for every object that has been measured.
   * Use these when a specific pre-calculated gap is absent from objectGaps:
   *   x: world-space X centre  (positive = right)
   *   z: world-space Z centre  (positive = toward camera)
   *   w: width  in metres (X axis)
   *   d: depth  in metres (Z axis)
   */
  map?:        { x: number; z: number; w: number; d: number };
  label:       string;
}

export interface SpatialDigest {
  /** Every detected object — the complete room inventory. */
  inventory:      ObjectInventoryEntry[];
  /** Clearances between primary-tier objects only. */
  objectGaps:     GapEntry[];
  wallClearances: WallClearance[];
  pathBlockages:  PathBlockage[];
  /**
   * UIDs of objects whose digest-space centroid was snapped by Structural Healing
   * (snapStackedObjects).  The store data is unchanged — these overrides exist
   * only within the digest so the AI and dashboard see a physically coherent layout.
   */
  healedUids?: string[];
}
