/**
 * Spatial Diagnostic types — geometry integrity checks for the loaded model.
 */

/** Which of the 6 structural boundary planes have confident mesh coverage. */
export interface BoundaryPlanes {
  floor:   boolean;
  ceiling: boolean;
  /** +Z wall */
  wallN:   boolean;
  /** -Z wall */
  wallS:   boolean;
  /** +X wall */
  wallE:   boolean;
  /** -X wall */
  wallW:   boolean;
}

/**
 * Freshly-computed spatial diagnostics — derived from scene geometry and the
 * current store state.  Re-computed after every scan and whenever manual
 * overrides change.
 */
export interface SpatialDiagnostics {
  /**
   * Mean angular deviation of floor-level upward normals from world Y-up,
   * in degrees.  0° = perfectly level.  > 2° indicates a tilted model.
   */
  verticalityError: number;

  /** Which structural boundary planes were confidently detected in the mesh. */
  boundaryPlanes: BoundaryPlanes;

  /**
   * How the active ceiling height was determined:
   *   "verified" — user-injected tape-measure override
   *   "measured" — from confident voxel geometry
   *   "fallback" — scene bounding box or hardcoded default
   */
  ceilingHeightSource: "verified" | "measured" | "fallback";

  /** Number of openings (doors / windows) detected across all scans. */
  openingsDetected: number;
}
