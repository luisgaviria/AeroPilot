import {
  Box3,
  Matrix3,
  Mesh,
  Object3D,
  Quaternion,
  Raycaster,
  Vector3,
  Scene as ThreeScene,
} from "three";
import type { BoundaryPlanes, SpatialDiagnostics } from "@/types/diagnostics";
import type { RoomDimensions } from "@/utils/spatial";
import type { DetectedObject } from "@/types/auto-discovery";
import type { AnchorMatch } from "@/utils/semanticScale";

// ── Shared helpers ──────────────────────────────────────────────────────────

const _up  = new Vector3(0, 1, 0);
const _rc  = new Raycaster();
const _nm  = new Matrix3();

/** Skip debug helpers injected by ScanBridge (Box3Helper wrappers). */
function isGeometry(obj: Object3D): obj is Mesh {
  return obj instanceof Mesh && !obj.name.startsWith("__");
}

// ── Verticality ─────────────────────────────────────────────────────────────

/**
 * Mean angular deviation of floor-level upward normals from (0,1,0), in
 * degrees.  Samples every vertex whose world Y is ≤ 0.35 m (floor slab).
 * Returns 0 when no floor geometry is found.
 */
export function measureVerticalityError(scene: Object3D): number {
  let sumAngle = 0;
  let count    = 0;

  scene.traverse((obj) => {
    if (!isGeometry(obj)) return;

    const geo      = obj.geometry;
    const normAttr = geo.attributes.normal;
    const posAttr  = geo.attributes.position;
    if (!normAttr || !posAttr) return;

    _nm.getNormalMatrix(obj.matrixWorld);

    for (let i = 0; i < normAttr.count; i++) {
      // Only floor-level vertices
      if (posAttr.getY(i) > 0.35) continue;

      const n = new Vector3(
        normAttr.getX(i),
        normAttr.getY(i),
        normAttr.getZ(i),
      )
        .applyMatrix3(_nm)
        .normalize();

      // Only upward-facing normals (floor, not wall or ceiling)
      if (n.y < 0.65) continue;

      sumAngle += Math.acos(Math.min(1, Math.max(-1, n.dot(_up))));
      count++;
    }
  });

  if (count === 0) return 0;
  return +((sumAngle / count) * (180 / Math.PI)).toFixed(2);
}

// ── Boundary planes ─────────────────────────────────────────────────────────

/**
 * Raycast from the room centre in 6 axis directions and check whether a mesh
 * surface is found within the expected boundary distance (+ TOLERANCE).
 */
export function detectBoundaryPlanes(
  scene: ThreeScene,
  room: RoomDimensions,
): BoundaryPlanes {
  /** Generous tolerance for irregular/open geometry (metres). */
  const TOLERANCE = 1.2;

  // Cast from mid-height room centre
  const origin = new Vector3(0, room.height / 2, 0);

  function hit(dir: Vector3, maxDist: number): boolean {
    _rc.set(origin, dir.normalize());
    _rc.far = maxDist + TOLERANCE;
    const hits = _rc
      .intersectObjects(scene.children, true)
      .filter((h) => !h.object.name.startsWith("__"));
    return hits.length > 0 && hits[0].distance <= maxDist + TOLERANCE;
  }

  return {
    floor:   hit(new Vector3( 0, -1,  0), room.height / 2),
    ceiling: hit(new Vector3( 0,  1,  0), room.height / 2),
    wallN:   hit(new Vector3( 0,  0,  1), room.length / 2),
    wallS:   hit(new Vector3( 0,  0, -1), room.length / 2),
    wallE:   hit(new Vector3( 1,  0,  0), room.width  / 2),
    wallW:   hit(new Vector3(-1,  0,  0), room.width  / 2),
  };
}

// ── Floor snap ──────────────────────────────────────────────────────────────

/**
 * Compute the corrective quaternion that rotates the dominant floor-plane
 * normal onto (0, 1, 0).  Returns identity when the floor is already level
 * (< 1°) or when no floor geometry is found.
 */
export function computeFloorSnapRotation(scene: Object3D): Quaternion {
  let sumNx = 0, sumNy = 0, sumNz = 0, count = 0;

  scene.traverse((obj) => {
    if (!isGeometry(obj)) return;

    const geo      = obj.geometry;
    const normAttr = geo.attributes.normal;
    const posAttr  = geo.attributes.position;
    if (!normAttr || !posAttr) return;

    _nm.getNormalMatrix(obj.matrixWorld);

    for (let i = 0; i < normAttr.count; i++) {
      if (posAttr.getY(i) > 0.35) continue;

      const n = new Vector3(
        normAttr.getX(i),
        normAttr.getY(i),
        normAttr.getZ(i),
      )
        .applyMatrix3(_nm)
        .normalize();

      if (n.y < 0.65) continue;

      sumNx += n.x; sumNy += n.y; sumNz += n.z;
      count++;
    }
  });

  if (count === 0) return new Quaternion(); // identity — nothing to correct

  const avg   = new Vector3(sumNx / count, sumNy / count, sumNz / count).normalize();
  const angle = Math.acos(Math.min(1, avg.dot(_up))) * (180 / Math.PI);
  if (angle < 1.0) return new Quaternion(); // already level

  return new Quaternion().setFromUnitVectors(avg, _up);
}

/**
 * Apply `computeFloorSnapRotation` to `target`, then re-lift the model so the
 * bounding-box floor sits at Y = 0.  Returns true if a correction was applied.
 */
export function applyFloorSnap(target: Object3D): boolean {
  const q = computeFloorSnapRotation(target);
  // Identity quaternion — dot(q, identity) ≈ 1 → no correction needed
  if (Math.abs(q.w - 1) < 1e-6 && q.x === 0 && q.y === 0 && q.z === 0) {
    return false;
  }

  target.quaternion.premultiply(q);
  target.updateMatrixWorld(true);

  // Re-lift so the post-rotation floor sits at Y = 0
  const box = new Box3().setFromObject(target);
  target.position.y -= box.min.y;
  target.updateMatrixWorld(true);

  return true;
}

// ── Spatial Manifest ─────────────────────────────────────────────────────────

export interface WallPlane {
  face:     "floor" | "ceiling" | "N" | "S" | "E" | "W";
  /** Outward unit normal in world space. */
  normal:   [number, number, number];
  /** Signed distance from world origin along the normal axis. */
  distance: number;
}

export interface SpatialManifest {
  schema:      "vista-spatial-manifest/v1";
  exportedAt:  string;
  room: {
    width:     number;
    length:    number;
    height:    number;
    floorArea: number;
  };
  scale: {
    auto:        number;
    verified:    number | null;
    effective:   number;
    anchorCount: number;
  };
  diagnostics: SpatialDiagnostics | null;
  wallPlanes:  WallPlane[];
  objects: Array<{
    uid:        string;
    name:       string;
    position:   [number, number, number];
    dimensions: { width: number; height: number; depth: number } | undefined;
    rawDimensions: { width: number; height: number; depth: number } | undefined;
    confidence: number | undefined;
    isOpening:  boolean;
    volumeAccuracy: number | undefined;
  }>;
}

export function buildSpatialManifest(
  room:                RoomDimensions,
  scaleFactor:         number,
  verifiedScaleFactor: number | null,
  anchorLog:           AnchorMatch[],
  diagnostics:         SpatialDiagnostics | null,
  detectedObjects:     DetectedObject[],
): SpatialManifest {
  const hw = room.width  / 2;
  const hl = room.length / 2;

  return {
    schema:     "vista-spatial-manifest/v1",
    exportedAt: new Date().toISOString(),
    room,
    scale: {
      auto:        scaleFactor,
      verified:    verifiedScaleFactor,
      effective:   verifiedScaleFactor ?? scaleFactor,
      anchorCount: anchorLog.filter((m) => m.included).length,
    },
    diagnostics,
    wallPlanes: [
      { face: "floor",   normal: [ 0, -1,  0], distance: 0           },
      { face: "ceiling", normal: [ 0,  1,  0], distance: room.height  },
      { face: "N",       normal: [ 0,  0,  1], distance: hl           },
      { face: "S",       normal: [ 0,  0, -1], distance: hl           },
      { face: "E",       normal: [ 1,  0,  0], distance: hw           },
      { face: "W",       normal: [-1,  0,  0], distance: hw           },
    ],
    objects: detectedObjects.map((o) => ({
      uid:           o.uid,
      name:          o.name,
      position:      o.position3D,
      dimensions:    o.dimensions,
      rawDimensions: o.rawDimensions,
      confidence:    o.confidence,
      isOpening:     o.isOpening ?? false,
      volumeAccuracy: o.volumeAccuracy,
    })),
  };
}
