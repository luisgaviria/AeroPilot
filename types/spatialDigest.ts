/**
 * Re-exported from utils/semanticScale so consumers can import from one place.
 * Defined in semanticScale to keep geometric types co-located with the engine.
 */
export type {
  PlausibilityTrial,
  PlausibilityIssue,
  PlausibilityAction,
  ValidationResult,
  SpatialHealthReport,
  SpatialHealthReportEntry,
} from "@/utils/semanticScale";

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
  /** Zone this object was assigned to by the Hybrid Zoning System. */
  zoneId?:     string;
}

// ─── Hybrid Zoning System types ───────────────────────────────────────────────

/**
 * A narrow corridor connecting two adjacent zones, identified when the gap
 * between two zone bounding boxes falls in the 0.8–1.2 m range.
 */
export interface TransitionPortal {
  /** IDs of the two zones on either side of this portal. */
  between: [string, string];
  /** Axis along which the gap runs (gap is perpendicular to travel direction). */
  axis:    "x" | "z";
  /** Measured corridor width in metres. */
  widthM:  number;
}

export type ZoneType = "bedroom" | "living" | "kitchen" | "hallway" | "living_bedroom" | "unclassified";

/**
 * One detected spatial zone.  Zones are derived from object clustering
 * (semantic) and optionally from geometric aperture analysis (hard split).
 */
export interface Zone {
  /** Stable short identifier, e.g. "zone-a". */
  id:                 string;
  /** Human-readable label, e.g. "Living Room", "Kitchen", "Hallway". */
  label:              string;
  type:               ZoneType;
  /** UIDs of every object (all tiers) assigned to this zone. */
  objectUids:         string[];
  /** Gross floor area of the zone AABB in m². */
  areaSqm:            number;
  /** Axis-aligned bounding box of the zone (objects + buffer). */
  bounds:             { xMin: number; xMax: number; zMin: number; zMax: number };
  /**
   * True when this zone was identified as (or is adjacent to) a Transition
   * Portal — a corridor identified by geometric aperture analysis.
   */
  isTransitionPortal?: boolean;
  /**
   * Unobstructed floor area in m² — zone AABB area minus the combined footprint
   * of all primary-tier fixtures.  Reported for renters evaluating empty units.
   */
  unobstructedFloorAreaM2?: number;
  /**
   * Kitchen width in metres — distance from the front of the cabinet bank to the
   * opposite room wall.  Present only on kitchen zones that contain a cabinet.
   */
  kitchenWidthM?: number;
  /**
   * Wall clearances computed using ONLY objects within this zone and only the
   * room walls that are spatially adjacent to this zone's AABB.
   * Used for localised proximity queries ("how much space on the living room
   * north wall?") without cross-contamination from other zones.
   */
  wallClearances:     WallClearance[];
  /**
   * Tape-measured width (X-axis) supplied by the user for this zone specifically.
   * When set, the engine applies a local X-axis correction to all objects in this
   * zone inside the digest (digest-only — store positions are unchanged).
   */
  verifiedWidthM:     number | null;
  /**
   * Tape-measured length (Z-axis) supplied by the user for this zone specifically.
   */
  verifiedLengthM:    number | null;
  /**
   * True when at least one verified dimension has been applied to this zone,
   * indicating that local calibration is active and overrides scan data.
   */
  isDimensionLocked:  boolean;
}

/**
 * Per-zone manual calibration overrides keyed by zone label (e.g. "Kitchen").
 * Used by buildSpatialDigest to apply local scale corrections digest-only.
 */
export type ZoneCalibrationMap = Record<string, { widthM: number | null; lengthM: number | null }>;

/**
 * Zone boundary as returned by the Gemini vision model.
 * Coordinates are real-world metres with room origin (0, 0) at the near-left corner.
 * X grows rightward, Z grows away from the viewer.
 *
 * Distinct from the computed `Zone` (which is built from object clustering).
 * GeminiZone provides the architectural ground truth; Zone provides the
 * occupancy-derived segmentation.
 */
export interface GeminiZone {
  id:    string;
  label: string;
  xMin:  number;
  xMax:  number;
  zMin:  number;
  zMax:  number;
}

export interface ZoneMap {
  zones:              Zone[];
  transitionPortals:  TransitionPortal[];
}

export interface SpatialDigest {
  /** Every detected object — the complete room inventory. */
  inventory:      ObjectInventoryEntry[];
  /** Clearances between primary-tier objects only. */
  objectGaps:     GapEntry[];
  /** Global wall clearances (full room, all objects). */
  wallClearances: WallClearance[];
  pathBlockages:  PathBlockage[];
  /**
   * UIDs of objects whose digest-space centroid was snapped by Structural Healing
   * (snapStackedObjects).  The store data is unchanged — these overrides exist
   * only within the digest so the AI and dashboard see a physically coherent layout.
   */
  healedUids?: string[];
  /**
   * Hybrid zone segmentation — always present.
   * When no primary-tier objects are detected, zones and transitionPortals are empty.
   * Each zone has its own wall clearances so the AI can answer localised queries.
   */
  zoneMap: ZoneMap;
  /**
   * Full per-object, per-iteration trial log produced by the Recursive Validation
   * Engine (runValidationLoop).  Present when ≥ 1 anchored object was evaluated.
   * Each entry records the issue detected, correction applied, and resulting score
   * so the AI and dashboard can surface convergence reasoning.
   */
  validationTrials?: import("@/utils/semanticScale").PlausibilityTrial[];
  /**
   * UIDs of objects flagged as Scan Artifacts after exhausting all validation
   * iterations.  These objects retain their position in the zone map but their
   * dimensions are excluded from objectGaps and wallClearances.
   */
  ghostArtifactUids?: string[];
  /**
   * Final Global Plausibility Score (0–100) after the validation loop converged.
   * A score ≥ 90 means every anchored object's dimensions are within tolerance.
   */
  globalPlausibilityScore?: number;
  /**
   * Structured Spatial Health Report — generated for every digest.
   * Documents every healing event (reason, before/after dims) without
   * requiring manual log inspection.
   */
  spatialHealthReport?: import("@/utils/semanticScale").SpatialHealthReport;
  /**
   * True when this digest was produced with a user-verified anchor room.
   * When true, globalScale is locked at 1.0× and all semantic healer passes
   * (Hybrid Validation, runValidationLoop) are bypassed for this session.
   * Object dimensions are treated as already-calibrated real-world values.
   * False when operating in normal auto-calibration mode.
   */
  isPreCalibrated: boolean;
}
