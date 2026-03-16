import {
  Matrix3,
  Box3,
  BufferAttribute,
  Camera,
  Intersection,
  Mesh,
  Plane,
  PerspectiveCamera,
  Raycaster,
  Sphere,
  Vector2,
  Vector3,
  Vector3Tuple,
  WebGLRenderer,
  WebGLRenderTarget,
  Scene as ThreeScene,
} from "three";

/**
 * True in development / test builds; false in production.
 * Used to suppress per-pixel raycaster logs that add Console overhead
 * without value in deployed builds.  Next.js replaces this at compile time,
 * so dead-code elimination removes the log branches entirely in production.
 */
const DEV = process.env.NODE_ENV !== "production";

// ─── Snapshot ──────────────────────────────────────────────────────────────────

/**
 * Captures the current WebGL canvas as a JPEG base64 string, scaled to CSS
 * pixel dimensions (clientWidth / clientHeight), which are DPR-normalised.
 *
 * CSS dims are used because:
 *   • R3F's camera projection matrix is calibrated to clientWidth/clientHeight.
 *   • Sending a CSS-sized image removes ambiguity about Gemini's internal
 *     rescaling — the image Gemini analyses matches the camera viewport exactly.
 *
 * Requires the Canvas to be mounted with `preserveDrawingBuffer: true`.
 */
export function captureSnapshot(canvas: HTMLCanvasElement): {
  base64: string;
  mimeType: string;
  width: number; // CSS pixel width  (= clientWidth)
  height: number; // CSS pixel height (= clientHeight)
} {
  const cssW =
    canvas.clientWidth ||
    Math.round(canvas.width / (window?.devicePixelRatio ?? 1));
  const cssH =
    canvas.clientHeight ||
    Math.round(canvas.height / (window?.devicePixelRatio ?? 1));

  // Cap at 720p to reduce API payload size while preserving aspect ratio.
  const MAX_H = 720;
  const scale = cssH > MAX_H ? MAX_H / cssH : 1;
  const outW = Math.round(cssW * scale);
  const outH = Math.round(cssH * scale);

  const tmp = document.createElement("canvas");
  tmp.width = outW;
  tmp.height = outH;
  const ctx = tmp.getContext("2d");
  if (!ctx)
    throw new Error(
      "[captureSnapshot] could not get 2D context from temp canvas"
    );
  // Fill with a neutral mid-gray before compositing the WebGL frame so that
  // transparent/black pixels (outside the room mesh) become a uniform gray
  // rather than pure black — reducing 'dead token' confusion for the vision model.
  ctx.fillStyle = "#808080";
  ctx.fillRect(0, 0, outW, outH);
  ctx.drawImage(canvas, 0, 0, outW, outH);

  const dataUrl = tmp.toDataURL("image/jpeg", 0.7);
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return { base64, mimeType: "image/jpeg", width: outW, height: outH };
}

/**
 * Returns a deep-frozen clone of the camera, with all matrices forced-current.
 *
 * Why: ScanBridge awaits the Vision API (~2s). During that time, CameraRig's
 * useFrame keeps mutating camera.position. If we raycast using the live camera
 * reference, the ray origin has drifted away from where the snapshot was taken.
 *
 * Call this IMMEDIATELY after captureSnapshot (before the API await) to lock
 * the camera state at the moment the image was taken.
 */
export function freezeCamera(camera: Camera): Camera {
  (camera as PerspectiveCamera).updateProjectionMatrix?.();
  camera.updateMatrixWorld(true);

  const clone = camera.clone() as PerspectiveCamera;
  // Explicitly copy computed matrices that clone() might not deep-copy:
  clone.projectionMatrix.copy((camera as PerspectiveCamera).projectionMatrix);
  clone.projectionMatrixInverse.copy(
    (camera as PerspectiveCamera).projectionMatrixInverse
  );
  clone.matrixWorld.copy(camera.matrixWorld);
  clone.matrixWorldInverse.copy((camera as any).matrixWorldInverse);

  return clone;
}

// ─── Raycaster ─────────────────────────────────────────────────────────────────

export const ROOM_Y_MIN = -0.1; // just below the floor
export const ROOM_Y_MAX = 2.8; // ceiling height — discards hallway/above-ceiling ghosts
const MAX_DIST = 6; // depth clip: anything > 6 m is outside the room box

/** Dynamically detected room enclosure from 6-axis raycasting. */
export interface DynamicBounds {
  minX: number; maxX: number;
  minY: number; maxY: number;
  minZ: number; maxZ: number;
}

/** Module-level cache — set by profileRoomBoundaries, read by getObjectMeshBounds. */
let _dynamicBounds: DynamicBounds | null = null;

// ── Punch-through filter constants ────────────────────────────────────────────
/** Hits closer than this are "lens dust" — tiny geometry right in front of the camera. */
const MIN_NEAR_DIST = 0.8;
/**
 * Bounding-sphere radius below which a mesh is treated as LiDAR noise / stray point.
 * Walls and floors have radii of several metres; noise triangles are < 0.1 m.
 */
const MIN_MESH_RADIUS = 0.15;

/** Object names that must snap to a vertical (wall) surface, not the floor. */
const WALL_SNAP_RE =
  /picture|painting|wall\s*art|artwork|frame|poster|mirror|window|door/i;

/**
 * Floor-level furniture — when all rays miss the mesh, snap the Y coordinate
 * to 0 so the label sits on the floor instead of floating at eye-level.
 */
const FLOOR_SNAP_RE =
  /sofa|couch|table|rug|carpet|chair|armchair|ottoman|bench|loveseat|sectional|desk|cabinet|sideboard|dresser|tv\s*stand|bookshelf|bookcase|shelf/i;

/** Returns the bounding-sphere radius of a mesh geometry (cheap noise pre-filter). */
function meshRadius(mesh: Mesh): number {
  const geom = mesh.geometry;
  if (!geom) return 0;
  if (!geom.boundingSphere) geom.computeBoundingSphere();
  return geom.boundingSphere?.radius ?? 0;
}

/**
 * World-space area of the specific triangle that the ray hit.
 *
 * Used as the winner-selection score: a wall triangle is far larger than any
 * floating noise fragment, so the raycaster naturally anchors to structure.
 * Floors have the biggest triangles of all, which is intentional — an object
 * sitting on the floor gets anchored to the floor plane, not a tiny mid-air shard.
 */
function hitFaceArea(h: Intersection, mesh: Mesh): number {
  if (!h.face || !mesh.geometry?.attributes?.position) return 0;
  const pos = mesh.geometry.attributes.position as BufferAttribute;
  const va = new Vector3()
    .fromBufferAttribute(pos, h.face.a)
    .applyMatrix4(mesh.matrixWorld);
  const vb = new Vector3()
    .fromBufferAttribute(pos, h.face.b)
    .applyMatrix4(mesh.matrixWorld);
  const vc = new Vector3()
    .fromBufferAttribute(pos, h.face.c)
    .applyMatrix4(mesh.matrixWorld);
  // Area = ½ |AB × AC|
  const ab = new Vector3().subVectors(vb, va);
  const ac = new Vector3().subVectors(vc, va);
  return ab.cross(ac).length() * 0.5;
}

/** True when the world-space normal points mostly upward/downward (floor / ceiling). */
function isHorizontal(worldNormal: Vector3): boolean {
  return Math.abs(worldNormal.y) > 0.7; // |cos θ| > 0.7 → θ < 45° from vertical axis
}

/**
 * Applies the full quality-filter pipeline to a raw intersection list.
 * Extracted so it can be reused by both the primary ray and bundle rays
 * without duplicating the near-clip / noise / back-face / wall-snap / Y-band logic.
 */
function filterHits(
  hits: Intersection[],
  isWallSnap: boolean,
  rc: Raycaster
): Intersection[] {
  const nm = new Matrix3();
  return hits.filter((h) => {
    if (!(h.object instanceof Mesh)) return false;
    if (h.distance < MIN_NEAR_DIST) return false;
    if (meshRadius(h.object) < MIN_MESH_RADIUS) return false;
    if (h.face) {
      nm.getNormalMatrix(h.object.matrixWorld);
      const wn = h.face.normal.clone().applyMatrix3(nm).normalize();
      if (rc.ray.direction.dot(wn) > 0) return false; // back-face
      if (isWallSnap && isHorizontal(wn)) return false; // wall-snap
    }
    return h.point.y >= ROOM_Y_MIN && h.point.y <= ROOM_Y_MAX;
  });
}

/**
 * Projects a 2D CSS-pixel coordinate from Gemini into 3D world space.
 *
 * Pipeline (all hits are examined, not just the first):
 *  1. Cast ray, collect ALL intersections up to MAX_DIST (6 m).
 *  2. Back-face filter — discard inside surfaces.
 *  3. Near-clip  — discard hits < MIN_NEAR_DIST (1 m) as "lens dust".
 *  4. Noise filter — discard meshes with bounding-sphere radius < MIN_MESH_RADIUS.
 *  5. Wall-snap  — for picture/art objects, discard horizontal surfaces so the
 *                  marker lands on the wall, not the floor beneath the picture.
 *  6. Y-band     — discard hits outside [ROOM_Y_MIN, ROOM_Y_MAX].
 *  7. Among survivors pick the LARGEST mesh (by bounding-sphere radius).
 *     Walls and floors beat small photogrammetry fragments; if the only survivor
 *     IS a piece of furniture its mesh is still larger than noise.
 *  8. null — no valid hit found.
 *
 * IMPORTANT: pass a frozen camera snapshot (from freezeCamera()) to avoid
 * the camera having drifted since the image was taken.
 *
 * @param pixelX       X coord in CSS pixels (0 = left edge)
 * @param pixelY       Y coord in CSS pixels (0 = top edge)
 * @param cssWidth     Canvas clientWidth  (same space as pixelX)
 * @param cssHeight    Canvas clientHeight (same space as pixelY)
 * @param frozenCamera A camera snapshot frozen at the moment of image capture
 * @param scene        R3F THREE.Scene
 * @param objectName    Gemini label for the object — used for wall-snap heuristic
 * @param depthFallback If set, return the point `depthFallback` metres along the
 *                      ray when no mesh is hit, rather than null.  Used by
 *                      ScanBridge to guarantee a 3D anchor even for thin geometry.
 */
export function raycastPixelTo3D(
  pixelX: number,
  pixelY: number,
  cssWidth: number,
  cssHeight: number,
  frozenCamera: Camera,
  scene: ThreeScene,
  objectName?: string,
  depthFallback?: number
): Vector3 | null {
  // ── NDC conversion ──────────────────────────────────────────────────────────
  const toNdc = (px: number, py: number) =>
    new Vector2((px / cssWidth) * 2 - 1, -(py / cssHeight) * 2 + 1);

  (frozenCamera as PerspectiveCamera).updateProjectionMatrix?.();
  frozenCamera.updateMatrixWorld(true);
  scene.updateMatrixWorld(true);

  const camArg = frozenCamera as Parameters<Raycaster["setFromCamera"]>[1];
  const isWallSnap = WALL_SNAP_RE.test(objectName ?? "");
  const isFloorSnap = FLOOR_SNAP_RE.test(objectName ?? "");

  /** Build a fresh Raycaster aimed at the given pixel coord. */
  function makeRay(px: number, py: number): Raycaster {
    const rc = new Raycaster();
    rc.far = MAX_DIST;
    rc.setFromCamera(toNdc(px, py), camArg);
    return rc;
  }

  /** Pick the best hit from a qualified list: largest face area wins. */
  function bestByArea(qs: Intersection[]): Intersection {
    return qs.reduce((w, h) =>
      hitFaceArea(h, h.object as Mesh) > hitFaceArea(w, w.object as Mesh)
        ? h
        : w
    );
  }

  // ── Pass 1: primary ray ────────────────────────────────────────────────────
  const primaryRay = makeRay(pixelX, pixelY);
  const primaryHits = primaryRay.intersectObjects(scene.children, true);

  if (DEV && primaryHits.length > 0) {
    primaryHits.slice(0, 4).forEach((h) => {
      const r =
        h.object instanceof Mesh ? meshRadius(h.object).toFixed(2) : "n/a";
      console.log(
        `[Ray1] "${h.object.name || "(unnamed)"}" dist=${h.distance.toFixed(
          2
        )} Y=${h.point.y.toFixed(2)} r=${r}`
      );
    });
  }

  const q1 = filterHits(primaryHits, isWallSnap, primaryRay);
  if (q1.length > 0) {
    const best = bestByArea(q1);
    const p = best.point;
    const meshR =
      best.object instanceof Mesh ? meshRadius(best.object).toFixed(2) : "?";
    if (DEV) console.log(
      `[spatial] ✓ primary  "${
        best.object.name || "(unnamed)"
      }" r=${meshR} dist=${best.distance.toFixed(2)} @ (${p.x.toFixed(
        2
      )},${p.y.toFixed(2)},${p.z.toFixed(2)})`
    );
    return p.clone();
  }

  // ── Pass 2: greedy bundle — 4 arms at ±8 px (cross pattern) ─────────────
  // A wider cross catches mesh edges that the centre ray misses entirely.
  // "Greedy" = deepest valid hit wins: seeding the voxel engine from deep
  // inside the object's volume produces a better cluster than the front face.
  const JITTER_PX = 8;
  const offsets: [number, number][] = [
    [JITTER_PX, 0],
    [-JITTER_PX, 0],
    [0, JITTER_PX],
    [0, -JITTER_PX],
  ];

  const bundleHits: Intersection[] = [];
  for (const [dx, dy] of offsets) {
    const rc = makeRay(pixelX + dx, pixelY + dy);
    const raw = rc.intersectObjects(scene.children, true);
    const valid = filterHits(raw, isWallSnap, rc);
    bundleHits.push(...valid);
  }

  if (bundleHits.length > 0) {
    // Deepest hit = furthest from camera = most penetrated into the object volume.
    const deepest = bundleHits.reduce((a, b) =>
      a.distance > b.distance ? a : b
    );
    const p = deepest.point;
    const meshName = deepest.object.name || "(unnamed)";
    const meshR =
      deepest.object instanceof Mesh
        ? meshRadius(deepest.object).toFixed(2)
        : "?";
    if (DEV) console.log(
      `[spatial] ✓ greedy-bundle "${meshName}" r=${meshR} dist=${deepest.distance.toFixed(
        2
      )} @ (${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)})`
    );
    return p.clone();
  }

  // ── Pass 3: semantic fallbacks (no mesh hit at all) ───────────────────────
  // Project a reference point 2 m along the primary ray for XZ position.
  const ref = new Vector3();
  primaryRay.ray.at(2.0, ref);

  // 3a. Floor anchor — furniture labels sit on the floor, never float.
  if (isFloorSnap) {
    const grounded = new Vector3(ref.x, 0, ref.z);
    if (DEV) console.log(
      `[spatial] ↓ floor-snap "${objectName}" → (${grounded.x.toFixed(
        2
      )}, 0.00, ${grounded.z.toFixed(2)})`
    );
    return grounded;
  }

  // 3b. Wall anchor — project onto the nearest vertical plane of the room box.
  if (isWallSnap) {
    const room = computeRoomBoundingBox(scene);
    if (room) {
      const { box } = room;
      const dists = [
        { axis: "x" as const, val: box.min.x, d: Math.abs(ref.x - box.min.x) },
        { axis: "x" as const, val: box.max.x, d: Math.abs(ref.x - box.max.x) },
        { axis: "z" as const, val: box.min.z, d: Math.abs(ref.z - box.min.z) },
        { axis: "z" as const, val: box.max.z, d: Math.abs(ref.z - box.max.z) },
      ];
      const nearest = dists.reduce((a, b) => (a.d < b.d ? a : b));
      const snapped = ref.clone();
      if (nearest.axis === "x") snapped.x = nearest.val;
      else snapped.z = nearest.val;
      // Keep Y in the room band
      snapped.y = Math.max(ROOM_Y_MIN, Math.min(ROOM_Y_MAX, snapped.y));
      if (DEV) console.log(
        `[spatial] ↓ wall-snap "${objectName}" → (${snapped.x.toFixed(
          2
        )},${snapped.y.toFixed(2)},${snapped.z.toFixed(2)})`
      );
      return snapped;
    }
  }

  // 3c. Generic depth fallback (last resort — keeps the label visible).
  if (
    depthFallback !== undefined &&
    ref.y >= ROOM_Y_MIN &&
    ref.y <= ROOM_Y_MAX
  ) {
    if (DEV) console.log(
      `[spatial] ↓ depth fallback "${
        objectName ?? "?"
      }" @ ${depthFallback}m → (${ref.x.toFixed(2)},${ref.y.toFixed(
        2
      )},${ref.z.toFixed(2)})`
    );
    return ref.clone();
  }

  console.warn(
    `[spatial] ✗ all strategies failed for "${objectName ?? "?"}" NDC (${toNdc(
      pixelX,
      pixelY
    ).x.toFixed(3)},${toNdc(pixelX, pixelY).y.toFixed(3)})`
  );
  return null;
}

// ─── Measurement helpers ───────────────────────────────────────────────────────

/**
 * Straight-line Euclidean distance between two 3D world-space points (metres).
 * Use this for label-to-label or edge-to-edge distance calculations.
 */
export function getDistanceBetween(
  posA: Vector3Tuple,
  posB: Vector3Tuple
): number {
  const dx = posB[0] - posA[0];
  const dy = posB[1] - posA[1];
  const dz = posB[2] - posA[2];
  return +Math.sqrt(dx * dx + dy * dy + dz * dz).toFixed(3);
}

/**
 * General Volume Engine — voxelizes the 3D scene near `centerPos` into a
 * 10 cm grid, flood-fills the connected solid region, and returns the object's
 * bounding dimensions plus its auto-centred world position.
 *
 * STEP 1 — VOXELIZATION
 *   Every vertex of every qualifying mesh within `searchRadius` is hashed into a
 *   10 cm voxel cell ("ix,iy,iz" string key).  Walls/ceilings (radius > 3 m),
 *   noise fragments (radius < 0.15 m), and floor verts (Y < 0.05 m) are excluded.
 *
 * STEP 2a — NEGATIVE-SPACE RULE (doors / openings)
 *   For objects matching NEGATIVE_SPACE_RE, rays are cast ±X and ±Z from the
 *   hit centre until a solid voxel is found.  The narrower horizontal gap becomes
 *   the opening width, the wider becomes depth.  No flood-fill is needed.
 *
 * STEP 2b — FLOOD-FILL CLUSTERING (all other objects)
 *   BFS from the voxel containing `centerPos` (or the nearest solid voxel within
 *   a 5-cell shell when the hit landed in empty air).  6-connectivity keeps the
 *   fill from bridging thin gaps between adjacent furniture pieces.
 *   Capped at FLOOD_MAX_VOXELS for safety.
 *
 * STEP 3 — HARD-TRUTH FLOOR SNAP
 *   If the cluster's lowest voxel is within 15 cm of Y = 0, the effective base is
 *   snapped to Y = 0, eliminating LiDAR ramp inflation globally.
 *
 * STEP 4 — AUTO-CENTERING
 *   The returned `center` is the centroid of the cluster bounding box.  ScanBridge
 *   writes this as position3D so AR labels sit at the physical centre of the object,
 *   not the user's click edge.
 */
const VOXEL_SIZE = 0.1; // 10 cm grid
const FLOOR_VERTEX_MIN = 0.2; // discard floor + low-base vertices below 20 cm
/** Face normals with Y < this are vertical (walls/cabinet sides) — excluded from solid. */
const HORIZ_FACE_MIN_Y = 0.5; // only upward-facing surfaces (furniture tops)
const FLOOR_SNAP_THRESHOLD = 0.15; // snap cluster base to Y=0 if within 15 cm
const FLOOD_MAX_VOXELS = 5_000; // BFS safety cap
const MAX_FURNITURE_MESH_RADIUS = 8.0; // raised: GLB may bake all geometry into 1-2 large meshes
/** Objects where we measure the AIR GAP (opening) rather than surrounding structure. */
const NEGATIVE_SPACE_RE = /door|opening|doorway|archway|passage|walkway|window/i;
/** Last-resort fallback radius when no solid voxel cluster is found. */
const RADIUS_FALLBACK_M = 0.3;
/** Fill-ratio (solid voxels / bbox voxels) below which adaptive BFS widens its gap. */
const MIN_FILL_RATIO = 0.15;
/** Maximum gap tolerance for adaptive BFS, in voxels (1 voxel = 10 cm → max 1 m). */
const MAX_ADAPTIVE_GAP = 10;
/** Clusters below this count are geometric fragments (pillow, thin strip, armrest…). */
const FRAGMENT_VOXELS = 100; // ratcheted up — medium headboards/slabs must promote
/** Cluster's shortest horizontal extent (voxels) below which it is treated as a slab
 *  (bed rail, headboard, side panel) regardless of voxel count or fill ratio. */
const MIN_SLAB_DIM = 5; // 50 cm — a slab always triggers connectivity search
/** Outward XZ search distance (voxels) when promoting a fragment to its major mass.
 *  Must be ≥ 5 (0.5 m) to bridge pillow→mattress→frame gaps. */
const MAJOR_MASS_SEARCH = 8; // 80 cm — explicitly > 0.5 m requirement
/** A Y-layer spreading > this × the median XZ area is a structural plate (floor/wall). */
const STRUCT_SPREAD_RATIO = 3.0;
/** Normal dot-product threshold — normals differing by > ~45° signal a structural boundary. */
const NORMAL_CLIP_DOT = 0.7;
/** Hard BFS cluster span cap in X and Z (voxels). Prevents wall-surface flooding. */
const MAX_BFS_HORIZ_SPAN = 22; // 2.2 m
/** Minimum XZ horizontal same-layer neighbor count — bridges thinner than this are severed. */
const NECK_MIN_WIDTH = 3;

function voxelKey(ix: number, iy: number, iz: number): string {
  return `${ix},${iy},${iz}`;
}

export function getObjectMeshBounds(
  scene: ThreeScene,
  centerPos: Vector3Tuple,
  searchRadius = 2.5,
  objectName = "",
  opts?: {
    neckMinWidth?: number;
    /**
     * Override the voxel grid resolution in metres (default 0.1).
     * Set to 0.05 for thin-cluster and ceiling-proximity re-passes.
     * Guards against infinite recursion: the recursive call always passes 0.05,
     * which is ≤ 0.05, so it never triggers another recursive call.
     */
    voxelSize?: number;
    /**
     * Room height in metres, used for:
     *   (a) ceiling-proximity detection (centre > 85 % of height → high-res pass)
     *   (b) ceiling-snap (top boundary within 10 cm of ceiling → extend to touch it)
     */
    roomHeight?: number;
    /**
     * Dynamic ground buffer (Clearance Buffer) — vertices below this Y value are
     * excluded from voxelization, creating an air gap between the floor mass and
     * the object volume.
     *
     * Defaults to FLOOR_VERTEX_MIN (0.20 m) when not set.
     *   Interior / ≥3 walls detected → 0.08 m  (Clearance Buffer: clears rugs, tiles,
     *                                            and baseboard geometry without cutting
     *                                            into low-profile furniture legs)
     *   Exterior / drone / <3 walls   → 0.35 m  (clears grass, curbs, terrain noise)
     *   Terrain Guard (tilt > 5°)     → 0.50 m  (prevents terrain-bleed into structures)
     */
    bufferHeight?: number;
  }
): {
  width: number;
  height: number;
  depth: number;
  center: Vector3Tuple;
  voxelCount: number;
  clipping_warning?: boolean;
  /** True for doors/windows — dimensions describe the void, not a solid mass. */
  isOpening?: boolean;
} | null {
  // ── Resolution: use caller-supplied voxel size or the default 0.1 m ──────────
  // `VS` replaces every VOXEL_SIZE reference inside this function so a high-res
  // re-pass at 0.05 m can be triggered without touching module-level constants.
  const VS = opts?.voxelSize ?? VOXEL_SIZE;
  // Scale the BFS horizontal-span cap proportionally so the same physical reach
  // is preserved regardless of grid resolution.
  // VS=0.10 → BFS_HORIZ_SPAN=22 voxels (2.2 m, unchanged)
  // VS=0.05 → BFS_HORIZ_SPAN=44 voxels (2.2 m physical span)
  const BFS_HORIZ_SPAN = Math.round(MAX_BFS_HORIZ_SPAN * (VOXEL_SIZE / VS));
  // Mode-aware ground buffer: caller supplies context-appropriate value; fall back to default.
  const effectiveFloorMin = opts?.bufferHeight ?? FLOOR_VERTEX_MIN;

  const origin = new Vector3(...centerPos);
  const sphere = new Sphere(origin, searchRadius);

  // Per-vertex voxelization sphere — capped at VOX_CAPTURE_RADIUS so that large
  // combined-mesh GLBs (where the whole apartment is 1-2 meshes) don't flood-fill
  // the entire room.  The wider `searchRadius` is still used for mesh-level culling.
  const VOX_CAPTURE_RADIUS = Math.min(searchRadius, 2.0);
  const voxSphere = new Sphere(origin, VOX_CAPTURE_RADIUS);

  // ── Step 1: Voxelize qualifying triangles within the voxSphere ───────────────
  // We compute per-face normals from triangle edge cross products so that BFS
  // can detect structural transitions even when the GLB carries no vertex-normal
  // attribute (e.g. baked / combined apartment meshes).
  const solid = new Set<string>();
  const normalMap = new Map<string, Vector3>(); // voxel key → accumulated face normals
  const vA = new Vector3(),
    vB = new Vector3(),
    vC = new Vector3();
  const e1 = new Vector3(),
    e2 = new Vector3(),
    fn = new Vector3();

  scene.traverse((obj) => {
    if (!(obj instanceof Mesh)) return;
    if (ENV_EXCLUDE.test(obj.name)) return;

    const r = meshRadius(obj);
    if (r < MIN_MESH_RADIUS) return;
    if (r > MAX_FURNITURE_MESH_RADIUS) return;

    obj.updateWorldMatrix(true, false);
    if (!sphere.intersectsBox(new Box3().setFromObject(obj))) return;

    const pa = obj.geometry?.attributes?.position as
      | BufferAttribute
      | undefined;
    if (!pa) return;

    const ia = obj.geometry.index;
    const triCount = ia ? ia.count / 3 : pa.count / 3;

    for (let t = 0; t < triCount; t++) {
      const i0 = ia ? ia.getX(t * 3) : t * 3;
      const i1 = ia ? ia.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = ia ? ia.getX(t * 3 + 2) : t * 3 + 2;

      vA.fromBufferAttribute(pa, i0).applyMatrix4(obj.matrixWorld);
      vB.fromBufferAttribute(pa, i1).applyMatrix4(obj.matrixWorld);
      vC.fromBufferAttribute(pa, i2).applyMatrix4(obj.matrixWorld);

      // Quick-reject: all three vertices below ground buffer or outside capture sphere
      const inA = vA.y >= effectiveFloorMin && voxSphere.containsPoint(vA);
      const inB = vB.y >= effectiveFloorMin && voxSphere.containsPoint(vB);
      const inC = vC.y >= effectiveFloorMin && voxSphere.containsPoint(vC);
      if (!inA && !inB && !inC) continue;

      // Face normal via cross product of triangle edges
      e1.subVectors(vB, vA);
      e2.subVectors(vC, vA);
      fn.crossVectors(e1, e2);
      const len = fn.length();
      if (len < 1e-10) continue; // degenerate triangle
      fn.divideScalar(len); // normalise in-place

      // Only voxelize upward-facing faces — walls (±X/±Z) and ceiling (-Y) are excluded.
      // This removes the room shell from the solid set, leaving only furniture top surfaces.
      if (fn.y < HORIZ_FACE_MIN_Y) continue;

      // Voxelize each qualifying vertex; accumulate this face's normal
      const verts = [vA, vB, vC] as const;
      const ins = [inA, inB, inC] as const;
      for (let vi = 0; vi < 3; vi++) {
        if (!ins[vi]) continue;
        const vt = verts[vi];
        const key = voxelKey(
          Math.floor(vt.x / VS),
          Math.floor(vt.y / VS),
          Math.floor(vt.z / VS)
        );
        solid.add(key);
        const ex = normalMap.get(key);
        if (ex) ex.add(fn);
        else normalMap.set(key, fn.clone());
      }
    }
  });

  // Normalise all accumulated normals to unit length
  for (const [, n] of normalMap) n.normalize();

  // ── Step 1b: Structural voxel set for opening/gap sweeps ─────────────────────
  // Unlike `solid` (upward-facing furniture surfaces only), `structural` captures
  // ALL geometry — walls, frames, sills, ceilings — so horizontal gap sweeps can
  // find structural hits even when the probe is floating in empty air.
  // Built only for openings (zero cost for regular objects).
  const structural = new Set<string>();
  if (NEGATIVE_SPACE_RE.test(objectName)) {
    const _sv = new Vector3();
    scene.traverse((obj) => {
      if (!(obj instanceof Mesh)) return;
      if (ENV_EXCLUDE.test(obj.name)) return;
      if (meshRadius(obj) < MIN_MESH_RADIUS) return;
      // No upper radius cap — room-enclosure meshes (walls, ceiling) ARE structural
      obj.updateWorldMatrix(true, false);
      if (!sphere.intersectsBox(new Box3().setFromObject(obj))) return;
      const pa = obj.geometry?.attributes?.position as BufferAttribute | undefined;
      if (!pa) return;
      for (let i = 0; i < pa.count; i++) {
        _sv.fromBufferAttribute(pa, i).applyMatrix4(obj.matrixWorld);
        if (!voxSphere.containsPoint(_sv)) continue;
        structural.add(voxelKey(
          Math.floor(_sv.x / VS),
          Math.floor(_sv.y / VS),
          Math.floor(_sv.z / VS),
        ));
      }
    });
    console.log(
      `[getObjectMeshBounds] "${objectName}" structural voxels: ${structural.size} ` +
      `(solid: ${solid.size})`
    );
  }

  // ── Step 2a: Negative-Space Rule — measure the AIR GAP for openings ──────────
  // Placed BEFORE the solid.size===0 guard because openings legitimately have
  // zero upward-facing (furniture) voxels — we measure the void, not solid mass.
  if (NEGATIVE_SPACE_RE.test(objectName)) {
    const oSX = Math.floor(origin.x / VS);
    const oSY = Math.floor(origin.y / VS);
    const oSZ = Math.floor(origin.z / VS);

    // Prefer structural (includes walls); fall back to solid when structural is empty.
    const scanSet = structural.size > 0 ? structural : solid;
    const MAX_SCAN = 80; // 80 voxels = 8 m

    function scanToStructural(dix: number, diy: number, diz: number): number {
      for (let s = 1; s <= MAX_SCAN; s++) {
        if (scanSet.has(voxelKey(oSX + s * dix, oSY + s * diy, oSZ + s * diz)))
          return s;
      }
      return MAX_SCAN;
    }

    const lft = scanToStructural(-1,  0,  0);
    const rgt = scanToStructural(+1,  0,  0);
    const fwd = scanToStructural( 0,  0, -1);
    const bck = scanToStructural( 0,  0, +1);
    const up  = scanToStructural( 0, +1,  0);
    const dn  = scanToStructural( 0, -1,  0);

    const gapX = (lft + rgt) * VS;
    const gapZ = (fwd + bck) * VS;

    // Opening width = LARGER horizontal gap (the span across the opening).
    // Depth = SMALLER horizontal gap (wall thickness / frame depth).
    const width = +Math.max(gapX, gapZ).toFixed(2);
    const depth = +Math.min(gapX, gapZ).toFixed(2);

    // Height = from sill/floor below the probe to the lintel above it.
    const lintelY = (oSY + up) * VS;
    const bottomY = Math.max(0, (oSY - dn) * VS);
    const height  = +Math.max(0, lintelY - bottomY).toFixed(2);

    console.log(
      `[getObjectMeshBounds] "${objectName}" opening sweep: ` +
      `±X=${lft}+${rgt} ±Z=${fwd}+${bck} ↑${up} ↓${dn} voxels ` +
      `→ ${width}×${height}×${depth} m (W×H×D)`
    );

    return {
      width, height, depth,
      center: centerPos,
      voxelCount: 0,
      isOpening: true,
    };
  }

  // ── Radius fallback ──────────────────────────────────────────────────────────
  // Used when voxelization finds no solid cells (ray landed on a wall/large mesh
  // excluded from the furniture grid) or when the BFS seed can't reach any voxel
  // within the 5-cell shell.  Scans ALL non-env meshes for vertices within
  // RADIUS_FALLBACK_M of centerPos and returns their AABB with floor snap.
  function radiusFallback(): {
    width: number;
    height: number;
    depth: number;
    center: Vector3Tuple;
    voxelCount: number;
  } | null {
    const fbBox = new Box3();
    const vt = new Vector3();
    let nearestName = "(none)";
    let nearestDist = Infinity;

    scene.traverse((obj) => {
      if (!(obj instanceof Mesh)) return;
      if (ENV_EXCLUDE.test(obj.name)) return;
      obj.updateWorldMatrix(true, false);
      const pa = obj.geometry?.attributes?.position;
      if (!pa) return;
      for (let i = 0; i < pa.count; i++) {
        vt.fromBufferAttribute(pa as BufferAttribute, i).applyMatrix4(
          obj.matrixWorld
        );
        const d = vt.distanceTo(origin);
        if (d <= RADIUS_FALLBACK_M) {
          fbBox.expandByPoint(vt);
          if (d < nearestDist) {
            nearestDist = d;
            nearestName = obj.name || "(unnamed)";
          }
        }
      }
    });

    if (fbBox.isEmpty()) return null;

    const fbBaseY = fbBox.min.y < FLOOR_SNAP_THRESHOLD ? 0 : fbBox.min.y;
    const fbSize = new Vector3();
    fbBox.getSize(fbSize);
    const fbH = +(fbBox.max.y - fbBaseY).toFixed(2);
    const fbCX = +(fbBox.min.x + fbSize.x / 2).toFixed(3);
    const fbCY = +(fbBaseY + fbH / 2).toFixed(3);
    const fbCZ = +(fbBox.min.z + fbSize.z / 2).toFixed(3);

    console.log(
      `[getObjectMeshBounds] "${objectName}" 30cm radius-fallback: ` +
        `${fbSize.x.toFixed(2)}×${fbH}×${fbSize.z.toFixed(2)} m ` +
        `via "${nearestName}" at ${nearestDist.toFixed(2)}m`
    );
    return {
      width: +fbSize.x.toFixed(2),
      height: fbH,
      depth: +fbSize.z.toFixed(2),
      center: [fbCX, fbCY, fbCZ],
      voxelCount: 0,
    };
  }

  if (solid.size === 0) {
    // Debug: diagnose WHY voxelization found no qualifying vertices
    let dbgName = "(none)";
    let dbgDist = Infinity;
    let dbgR = 0;
    const vt = new Vector3();
    scene.traverse((obj) => {
      if (!(obj instanceof Mesh)) return;
      obj.updateWorldMatrix(true, false);
      const pa = obj.geometry?.attributes?.position;
      if (!pa) return;
      const step = Math.max(1, Math.floor(pa.count / 30));
      for (let i = 0; i < pa.count; i += step) {
        vt.fromBufferAttribute(pa as BufferAttribute, i).applyMatrix4(
          obj.matrixWorld
        );
        const d = vt.distanceTo(origin);
        if (d < dbgDist) {
          dbgDist = d;
          dbgName = obj.name || "(unnamed)";
          dbgR = meshRadius(obj);
        }
      }
    });
    const why =
      dbgR < MIN_MESH_RADIUS
        ? `r=${dbgR.toFixed(2)} < ${MIN_MESH_RADIUS} (noise fragment)`
        : dbgR > MAX_FURNITURE_MESH_RADIUS
        ? `r=${dbgR.toFixed(
            2
          )} > ${MAX_FURNITURE_MESH_RADIUS} (wall/ceiling/env)`
        : `outside search sphere (${searchRadius}m)`;
    console.warn(
      `[getObjectMeshBounds] "${objectName}" no solid voxels @ ` +
        `(${centerPos.map((n) => n.toFixed(2)).join(", ")}) — ` +
        `nearest mesh: "${dbgName}" at ${dbgDist.toFixed(2)}m [${why}]`
    );
    return radiusFallback();
  }

  // Opening detections returned early above — only solid-mass BFS reaches here.
  const sx = Math.floor(origin.x / VS);
  const sy = Math.floor(origin.y / VS);
  const sz = Math.floor(origin.z / VS);

  // ── Step 2b: Seed search ─────────────────────────────────────────────────────
  let seedX = sx,
    seedY = sy,
    seedZ = sz;

  if (!solid.has(voxelKey(seedX, seedY, seedZ))) {
    let found = false;
    const seedSearchR = Math.floor(VOX_CAPTURE_RADIUS / VS);
    outerSearch: for (let r = 1; r <= seedSearchR; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = 0; dy <= r; dy++) {
          // never search below probe — avoids seeding on floor
          for (let dz = -r; dz <= r; dz++) {
            if (Math.max(Math.abs(dx), dy, Math.abs(dz)) !== r) continue;
            if (sy + dy < 1) continue; // also skip below voxel 1
            if (solid.has(voxelKey(sx + dx, sy + dy, sz + dz))) {
              seedX = sx + dx;
              seedY = sy + dy;
              seedZ = sz + dz;
              found = true;
              break outerSearch;
            }
          }
        }
      }
    }
    if (!found) {
      console.warn(
        `[getObjectMeshBounds] "${objectName}" BFS seed not found ` +
          `(${solid.size} solid voxels, none within ${seedSearchR}-cell upward shell of ` +
          `voxel (${sx},${sy},${sz})) — trying 30cm radius fallback`
      );
      return radiusFallback();
    }
  }

  // ── Step 2c: Adaptive BFS ────────────────────────────────────────────────────
  // Starts at strict 6-connectivity (gap=1 voxel) and widens in 10 cm steps.
  // Stops when the cluster is dense enough (fill ratio ≥ MIN_FILL_RATIO) or
  // mass growth has stabilised (<5 % change) — no object-type knowledge needed.
  type BFSResult = {
    visited: Set<string>;
    minIX: number;
    maxIX: number;
    minIY: number;
    maxIY: number;
    minIZ: number;
    maxIZ: number;
    clipped: boolean;
  };

  function bfs(
    fx: number,
    fy: number,
    fz: number,
    gapVoxels: number
  ): BFSResult {
    const vis = new Set<string>();
    const q: [number, number, number][] = [[fx, fy, fz]];
    vis.add(voxelKey(fx, fy, fz));
    // AABB updated immediately on ADD (not on dequeue) so span checks are accurate.
    let mnX = fx,
      mxX = fx,
      mnY = fy,
      mxY = fy,
      mnZ = fz,
      mxZ = fz;

    while (q.length > 0 && vis.size < FLOOD_MAX_VOXELS) {
      const [cx, cy, cz] = q.shift()!;

      const srcNormal = normalMap.get(voxelKey(cx, cy, cz));

      for (const [bx, by, bz] of [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1],
      ] as [number, number, number][]) {
        for (let s = 1; s <= gapVoxels; s++) {
          const nx = cx + bx * s,
            ny = cy + by * s,
            nz = cz + bz * s;
          // Hard horizontal span cap — checked against the already-added AABB.
          // Uses BFS_HORIZ_SPAN (scaled from MAX_BFS_HORIZ_SPAN by VS) so the
          // physical reach stays constant regardless of voxel resolution.
          if (
            bx !== 0 &&
            Math.max(mxX, nx) - Math.min(mnX, nx) + 1 > BFS_HORIZ_SPAN
          )
            break;
          if (
            bz !== 0 &&
            Math.max(mxZ, nz) - Math.min(mnZ, nz) + 1 > BFS_HORIZ_SPAN
          )
            break;
          const nk = voxelKey(nx, ny, nz);
          if (!vis.has(nk) && solid.has(nk)) {
            // Normal-based clipping: stop expansion across ~45°+ surface transitions.
            if (srcNormal) {
              const nbrNormal = normalMap.get(nk);
              if (nbrNormal && srcNormal.dot(nbrNormal) < NORMAL_CLIP_DOT)
                break;
            }
            vis.add(nk);
            q.push([nx, ny, nz]);
            // Update AABB immediately so subsequent span checks are accurate.
            if (nx < mnX) mnX = nx;
            else if (nx > mxX) mxX = nx;
            if (ny < mnY) mnY = ny;
            else if (ny > mxY) mxY = ny;
            if (nz < mnZ) mnZ = nz;
            else if (nz > mxZ) mxZ = nz;
            break; // first solid hit in this direction — don't leap further
          }
        }
      }
    }
    return {
      visited: vis,
      minIX: mnX,
      maxIX: mxX,
      minIY: mnY,
      maxIY: mxY,
      minIZ: mnZ,
      maxIZ: mxZ,
      clipped: vis.size >= FLOOD_MAX_VOXELS,
    };
  }

  // ── Neck detection — severs thin bridges (< NECK_MIN_WIDTH horizontal neighbors) ──
  // After BFS finds a cluster, removes voxels that form narrow seams (1-2 wide)
  // and keeps only the connected component containing the BFS seed.
  function applyNeckDetection(result: BFSResult, neckMinWidth = NECK_MIN_WIDTH): BFSResult {
    const { visited } = result;

    const thin = new Set<string>();
    for (const key of visited) {
      const [ix, iy, iz] = key.split(",").map(Number);
      let hCount = 0;
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as [number, number][]) {
        if (visited.has(voxelKey(ix + dx, iy, iz + dz))) hCount++;
      }
      if (hCount < neckMinWidth) thin.add(key);
    }

    if (thin.size === 0) return result; // no thin voxels — nothing to prune

    // If the BFS seed itself is a thin voxel, neck detection is unreliable — skip
    const seedKey = voxelKey(seedX, seedY, seedZ);
    if (!visited.has(seedKey) || thin.has(seedKey)) {
      console.log(
        `[getObjectMeshBounds] "${objectName}" neck detection: seed thin — skipping`
      );
      return result;
    }

    // BFS from seed through non-thin voxels (strict 6-connectivity, no gap bridging)
    const main = new Set<string>();
    const q2: [number, number, number][] = [[seedX, seedY, seedZ]];
    main.add(seedKey);
    let mnX = seedX,
      mxX = seedX,
      mnY = seedY,
      mxY = seedY,
      mnZ = seedZ,
      mxZ = seedZ;

    while (q2.length > 0) {
      const [cx, cy, cz] = q2.shift()!;
      if (cx < mnX) mnX = cx;
      else if (cx > mxX) mxX = cx;
      if (cy < mnY) mnY = cy;
      else if (cy > mxY) mxY = cy;
      if (cz < mnZ) mnZ = cz;
      else if (cz > mxZ) mxZ = cz;
      for (const [bx, by, bz] of [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1],
      ] as [number, number, number][]) {
        const nk = voxelKey(cx + bx, cy + by, cz + bz);
        if (visited.has(nk) && !thin.has(nk) && !main.has(nk)) {
          main.add(nk);
          q2.push([cx + bx, cy + by, cz + bz]);
        }
      }
    }

    if (main.size === 0 || main.size >= visited.size) return result;
    console.log(
      `[getObjectMeshBounds] "${objectName}" neck cut: ${visited.size} → ${main.size} voxels`
    );
    return {
      visited: main,
      minIX: mnX,
      maxIX: mxX,
      minIY: mnY,
      maxIY: mxY,
      minIZ: mnZ,
      maxIZ: mxZ,
      clipped: result.clipped,
    };
  }

  let best = bfs(seedX, seedY, seedZ, 3);
  let prevSize = best.visited.size;

  for (let gap = 4; gap <= MAX_ADAPTIVE_GAP; gap++) {
    const bboxVox =
      (best.maxIX - best.minIX + 1) *
      (best.maxIY - best.minIY + 1) *
      (best.maxIZ - best.minIZ + 1);
    const fillRatio = best.visited.size / Math.max(bboxVox, 1);

    // Slab check: even a "dense" cluster must keep expanding if it is thinner than
    // MIN_SLAB_DIM in either horizontal direction (rail, headboard, side panel).
    const minHoriz = Math.min(
      best.maxIX - best.minIX + 1,
      best.maxIZ - best.minIZ + 1
    );
    if (fillRatio >= MIN_FILL_RATIO && minHoriz >= MIN_SLAB_DIM) break; // dense AND not slab

    const candidate = bfs(seedX, seedY, seedZ, gap);
    const delta =
      Math.abs(candidate.visited.size - prevSize) / Math.max(prevSize, 1);
    if (delta < 0.05) {
      console.log(
        `[getObjectMeshBounds] "${objectName}" adaptive: stabilised at gap=${
          gap - 1
        } voxel (Δ=${(delta * 100).toFixed(1)}%)`
      );
      break;
    }
    console.log(
      `[getObjectMeshBounds] "${objectName}" adaptive: gap=${gap} voxels=${
        candidate.visited.size
      } fill=${(fillRatio * 100).toFixed(0)}%`
    );
    prevSize = candidate.visited.size;
    best = candidate;
  }

  // ── Step 3: Fragment → Major-Mass promotion ───────────────────────────────────
  // A "fragment" is either (a) a small cluster OR (b) a slab — thin in one
  // horizontal direction (headboard, rail, side panel).  Both trigger an outward
  // search for the nearest larger connected mass within MAJOR_MASS_SEARCH voxels.
  const postBfsSlabDim = Math.min(
    best.maxIX - best.minIX + 1,
    best.maxIZ - best.minIZ + 1
  );
  const isGeometricFragment =
    best.visited.size < FRAGMENT_VOXELS || postBfsSlabDim < MIN_SLAB_DIM;

  if (isGeometricFragment) {
    let majorSeedX = -1,
      majorSeedY = -1,
      majorSeedZ = -1;
    let majorSize = best.visited.size;
    const tried = new Set<string>();

    for (const key of best.visited) {
      const [ix, iy, iz] = key.split(",").map(Number);
      for (const [bx, bz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as [number, number][]) {
        for (let s = 1; s <= MAJOR_MASS_SEARCH; s++) {
          const ck = voxelKey(ix + bx * s, iy, iz + bz * s);
          if (!best.visited.has(ck) && solid.has(ck) && !tried.has(ck)) {
            tried.add(ck);
            // gap=5 (50 cm) lets the probe bridge pillow→mattress→frame gaps
            const probe = bfs(ix + bx * s, iy, iz + bz * s, 5);
            if (probe.visited.size > majorSize) {
              majorSize = probe.visited.size;
              majorSeedX = ix + bx * s;
              majorSeedY = iy;
              majorSeedZ = iz + bz * s;
            }
            break;
          }
        }
      }
    }

    if (majorSeedX !== -1) {
      const reason =
        postBfsSlabDim < MIN_SLAB_DIM
          ? `slab(dim=${postBfsSlabDim})`
          : `fragment`;
      console.log(
        `[getObjectMeshBounds] "${objectName}" ${reason}(${best.visited.size}) → major mass(${majorSize}) promoted`
      );
      best = bfs(majorSeedX, majorSeedY, majorSeedZ, 1);
    }
  }

  // ── Step 3b: Neck detection — sever thin bridges between disconnected masses ──
  best = applyNeckDetection(best, opts?.neckMinWidth ?? NECK_MIN_WIDTH);

  // ── Step 4: Structural plate trimming ────────────────────────────────────────
  // Compute per-Y-layer XZ footprint (cells).  Layers spreading more than
  // STRUCT_SPREAD_RATIO × the median layer are "structural plates" — floor panels,
  // wall-flush bases — and are removed before measuring the object itself.
  {
    const layerBox = new Map<number, [number, number, number, number]>(); // iy → [mnX,mxX,mnZ,mxZ]
    for (const key of best.visited) {
      const [ix, iy, iz] = key.split(",").map(Number);
      const b = layerBox.get(iy);
      if (b) {
        if (ix < b[0]) b[0] = ix;
        if (ix > b[1]) b[1] = ix;
        if (iz < b[2]) b[2] = iz;
        if (iz > b[3]) b[3] = iz;
      } else layerBox.set(iy, [ix, ix, iz, iz]);
    }

    const spreads = Array.from(layerBox.entries())
      .map(([iy, b]) => ({ iy, spread: (b[1] - b[0] + 1) * (b[3] - b[2] + 1) }))
      .sort((a, b) => a.spread - b.spread);
    const median = spreads[Math.floor(spreads.length / 2)]?.spread ?? 1;

    // Structural plates are always at the BASE of an object (floor-contact panels,
    // plinth rails).  The top surface of flat objects — tabletop, bed surface, desk —
    // is the actual functional geometry and must NEVER be trimmed.
    // Guard: only layers in the bottom 25 % of the cluster's Y range are eligible.
    const bottomCutoff =
      best.minIY + Math.ceil((best.maxIY - best.minIY) * 0.25);
    const structural = new Set(
      spreads
        .filter(
          (s) => s.spread > median * STRUCT_SPREAD_RATIO && s.iy <= bottomCutoff
        )
        .map((s) => s.iy)
    );

    if (structural.size > 0 && structural.size < spreads.length) {
      let tMnX = Infinity,
        tMxX = -Infinity,
        tMnY = Infinity,
        tMxY = -Infinity,
        tMnZ = Infinity,
        tMxZ = -Infinity;
      const trimmed = new Set<string>();
      for (const key of best.visited) {
        const [ix, iy, iz] = key.split(",").map(Number);
        if (structural.has(iy)) continue;
        trimmed.add(key);
        if (ix < tMnX) tMnX = ix;
        if (ix > tMxX) tMxX = ix;
        if (iy < tMnY) tMnY = iy;
        if (iy > tMxY) tMxY = iy;
        if (iz < tMnZ) tMnZ = iz;
        if (iz > tMxZ) tMxZ = iz;
      }
      if (trimmed.size > 0) {
        console.log(
          `[getObjectMeshBounds] "${objectName}" structural trim: removed ${
            best.visited.size - trimmed.size
          } plate voxels (>${STRUCT_SPREAD_RATIO}× median spread)`
        );
        best = {
          visited: trimmed,
          minIX: tMnX,
          maxIX: tMxX,
          minIY: tMnY,
          maxIY: tMxY,
          minIZ: tMnZ,
          maxIZ: tMxZ,
          clipped: best.clipped,
        };
      }
    }
  }

  // ── Step 5: Hard-Truth Floor snap ────────────────────────────────────────────
  const rawBaseY = best.minIY * VS;
  const baseY = rawBaseY < FLOOR_SNAP_THRESHOLD ? 0 : rawBaseY;

  // ── Step 6: Bounding box + auto-centred position ─────────────────────────────
  const width  = +((best.maxIX - best.minIX + 1) * VS).toFixed(2);
  let   height = +((best.maxIY + 1) * VS - baseY).toFixed(2);
  const depth  = +((best.maxIZ - best.minIZ + 1) * VS).toFixed(2);

  // Anchor the returned center at the BFS seed voxel (XZ).
  const centerX = +((seedX + 0.5) * VS).toFixed(3);
  const centerY = +(baseY + height / 2).toFixed(3);
  const centerZ = +((seedZ + 0.5) * VS).toFixed(3);

  // ── Ceiling snap (req 4) ──────────────────────────────────────────────────────
  // If the cluster's top boundary is within 10 cm of the detected ceiling plane,
  // extend height to meet it exactly — eliminates the tape-measure gap on tall
  // objects (wardrobes, curtains, wall panels) and ceiling-mounted fixtures.
  if (opts?.roomHeight != null) {
    const topY = baseY + height;
    const gap  = opts.roomHeight - topY;
    if (gap >= 0 && gap < 0.10) {
      const snapped = +(opts.roomHeight - baseY).toFixed(2);
      console.log(
        `[getObjectMeshBounds] "${objectName}" ceiling snap: ` +
        `${height.toFixed(3)} → ${snapped.toFixed(3)} m (gap was ${gap.toFixed(3)} m)`
      );
      height = snapped;
    }
  }

  // ── Adaptive voxel resolution (req 1 + 2) ────────────────────────────────────
  // Trigger a high-res (0.05 m) re-pass when:
  //   (a) The cluster is geometrically "thin" — min(w, h, d) < 0.15 m.
  //       Catches wall panels, shelf lips, ceiling fans, and any planar feature
  //       that spans ≤ 1 voxel at 0.10 m resolution.
  //   (b) The object centre is in the top 15 % of the room's Y-enclosure.
  //       Ensures ceiling-mounted fixtures are measured accurately regardless
  //       of their label (fans, pendant lights, smoke detectors, roof vents).
  // Guard: only recurse when VS > 0.05 so the re-pass never triggers another.
  if (VS > 0.05) {
    const minDim     = Math.min(width, height, depth);
    const nearCeiling = opts?.roomHeight != null && centerY > opts.roomHeight * 0.85;
    if (minDim < 0.15 || nearCeiling) {
      console.log(
        `[getObjectMeshBounds] "${objectName}" → high-res pass (VS=0.05): ` +
        `minDim=${minDim.toFixed(2)} m nearCeiling=${nearCeiling}`
      );
      const hires = getObjectMeshBounds(scene, centerPos, searchRadius, objectName, {
        ...opts,
        voxelSize: 0.05,
      });
      if (hires) return hires;
      // High-res pass returned null (no voxels at finer grid) — keep coarse result.
      console.warn(
        `[getObjectMeshBounds] "${objectName}" high-res pass returned null — using 0.10 m result`
      );
    }
  }

  return {
    width,
    height,
    depth,
    center: [centerX, centerY, centerZ],
    voxelCount: best.visited.size,
    ...(best.clipped ? { clipping_warning: true } : {}),
  };
}

/**
 * Projects a 2D pixel coordinate onto an arbitrary world-space plane.
 *
 * Used when an edge raycast misses real geometry (e.g. a door-frame ray passes
 * through empty space) but we know the object lies on a specific plane — the
 * wall it is mounted on. Guarantees both left and right edges land on the same
 * plane so the width measurement is a true horizontal span, not a diagonal.
 *
 * Returns null if the ray is parallel to the plane (dot product ≈ 0).
 */
export function projectPixelOntoPlane(
  pixelX: number,
  pixelY: number,
  cssWidth: number,
  cssHeight: number,
  frozenCamera: Camera,
  planeNormal: Vector3,
  planePoint: Vector3
): Vector3 | null {
  const ndc = new Vector2(
    (pixelX / cssWidth) * 2 - 1,
    -(pixelY / cssHeight) * 2 + 1
  );
  (frozenCamera as PerspectiveCamera).updateProjectionMatrix?.();
  frozenCamera.updateMatrixWorld(true);

  const rc = new Raycaster();
  rc.setFromCamera(
    ndc as any,
    frozenCamera as Parameters<Raycaster["setFromCamera"]>[1]
  );

  const plane = new Plane().setFromNormalAndCoplanarPoint(
    planeNormal,
    planePoint
  );
  const result = new Vector3();
  return rc.ray.intersectPlane(plane, result);
}

// ─── Room bounding box ─────────────────────────────────────────────────────────

/**
 * Mesh names that should never be counted as room geometry.
 * drei's <Environment> creates a mesh often named "environment_*"; Three.js
 * helpers carry names like "GridHelper", "AxesHelper", etc.
 */
const ENV_EXCLUDE = /environment|sky|background|grid|helper|bone/i;

/** Any room mesh with a bounding-sphere radius larger than this is a sky/env sphere. */
const MAX_ROOM_MESH_RADIUS = 20; // metres

/**
 * Minimum vertex count for a mesh to be considered real room geometry.
 * Stray photogrammetry points and degenerate hallway fragments typically have
 * fewer than this many vertices; skip them to avoid corrupting the bbox.
 */
const MIN_VERTEX_COUNT = 20;

/**
 * Traverses the scene and returns the combined world-space bounding box PLUS
 * the volume-weighted centroid of all qualifying room-geometry meshes.
 *
 * A mesh qualifies when ALL of the following hold:
 *   • its name matches /room|mesh/i
 *   • its name does NOT match ENV_EXCLUDE
 *   • its bounding-sphere radius ≤ MAX_ROOM_MESH_RADIUS
 *   • its geometry has ≥ MIN_VERTEX_COUNT vertices (filters noise/hallway fragments)
 *
 * The centroid is the volume-weighted average of each sub-mesh's bbox centre,
 * giving a stable "centre of mass" even for L-shaped / asymmetric rooms.
 */
export function computeRoomBoundingBox(
  scene: ThreeScene
): { box: Box3; centroid: Vector3 } | null {
  const box = new Box3();
  const centroid = new Vector3();
  const sphere = new Sphere();
  let totalVol = 0;

  scene.traverse((obj) => {
    if (!(obj instanceof Mesh)) return;
    if (!/room|mesh/i.test(obj.name)) return;
    if (ENV_EXCLUDE.test(obj.name)) return;

    // Skip degenerate / hallway-noise meshes with too few vertices.
    const vertexCount = obj.geometry?.attributes?.position?.count ?? 0;
    if (vertexCount < MIN_VERTEX_COUNT) return;

    obj.updateWorldMatrix(true, false);
    const meshBox = new Box3().setFromObject(obj);
    if (meshBox.isEmpty()) return;

    // Reject sky / environment spheres by radius.
    meshBox.getBoundingSphere(sphere);
    if (sphere.radius > MAX_ROOM_MESH_RADIUS) return;

    const meshSize = new Vector3();
    meshBox.getSize(meshSize);
    const vol = Math.max(meshSize.x * meshSize.y * meshSize.z, 1e-6);

    const meshCenter = new Vector3();
    meshBox.getCenter(meshCenter);
    centroid.addScaledVector(meshCenter, vol);
    totalVol += vol;

    box.union(meshBox);
  });

  if (totalVol === 0) return null;

  centroid.divideScalar(totalVol);
  return { box, centroid };
}

/**
 * Profiles the room enclosure by raycasting from the scene origin in all 6
 * cardinal directions. Sets the module-level _dynamicBounds cache so subsequent
 * getObjectMeshBounds calls can clip vertices above the detected ceiling.
 *
 * Call once after the GLB loads (e.g. in SpatialTestBridge after scene is ready).
 */
export function profileRoomBoundaries(scene: ThreeScene): DynamicBounds {
  const rc = new Raycaster();
  rc.far = 25;
  const origin = new Vector3(0, 1.6, 0); // eye level at scene centre

  const defaults: DynamicBounds = {
    minX: -6, maxX: 6,
    minY:  0, maxY: 2.8,
    minZ: -6, maxZ: 6,
  };

  const probes: Array<{ dir: Vector3; key: keyof DynamicBounds; axis: "x" | "y" | "z" }> = [
    { dir: new Vector3( 1, 0, 0), key: "maxX", axis: "x" },
    { dir: new Vector3(-1, 0, 0), key: "minX", axis: "x" },
    { dir: new Vector3( 0, 1, 0), key: "maxY", axis: "y" },
    { dir: new Vector3( 0,-1, 0), key: "minY", axis: "y" },
    { dir: new Vector3( 0, 0, 1), key: "maxZ", axis: "z" },
    { dir: new Vector3( 0, 0,-1), key: "minZ", axis: "z" },
  ];

  const result = { ...defaults };

  for (const { dir, key, axis } of probes) {
    rc.set(origin, dir);
    const hits = rc.intersectObjects(scene.children, true);
    const hit = hits.find(
      (h) =>
        h.object instanceof Mesh &&
        meshRadius(h.object as Mesh) > 0.5 &&
        !ENV_EXCLUDE.test(h.object.name),
    );
    if (hit) result[key] = +hit.point[axis].toFixed(2);
  }

  console.log(
    `[profileRoomBoundaries] enclosure: ` +
    `X[${result.minX},${result.maxX}] ` +
    `Y[${result.minY},${result.maxY}] ` +
    `Z[${result.minZ},${result.maxZ}]`,
  );

  _dynamicBounds = result;
  return result;
}

/**
 * 2-D projection map of all floor-level scene vertices onto a 25 cm grid.
 * Returns the actual traversable floor area in m² — correctly handles L-shapes,
 * nooks, pillars, and recesses without any hard-coded shape knowledge.
 */
function computeFloorArea(scene: ThreeScene): number {
  const GRID = 0.25; // 25 cm cells
  const FLOOR_TOP = 0.3; // vertices ≤ 0.30 m count as floor footprint
  const occupied = new Set<string>();
  const v = new Vector3();

  scene.traverse((obj) => {
    if (!(obj instanceof Mesh)) return;
    if (ENV_EXCLUDE.test(obj.name)) return;
    const r = meshRadius(obj);
    if (r < 0.5 || r > MAX_ROOM_MESH_RADIUS) return; // skip fragments and sky spheres
    obj.updateWorldMatrix(true, false);
    const pa = obj.geometry?.attributes?.position;
    if (!pa) return;
    for (let i = 0; i < pa.count; i++) {
      v.fromBufferAttribute(pa as BufferAttribute, i).applyMatrix4(
        obj.matrixWorld
      );
      if (v.y >= 0 && v.y <= FLOOR_TOP) {
        occupied.add(`${Math.floor(v.x / GRID)},${Math.floor(v.z / GRID)}`);
      }
    }
  });

  return +(occupied.size * GRID * GRID).toFixed(1);
}

/** Human-readable room measurements used for AI spatial reasoning. */
export interface RoomDimensions {
  /** Room width  along the X axis (metres, 2 d.p.). */
  width: number;
  /** Room length along the Z axis (metres, 2 d.p.). */
  length: number;
  /** Room height along the Y axis (metres, 2 d.p.). */
  height: number;
  /** True floor area in m² from the 2-D voxel projection map (concave-aware). */
  floorArea: number;
}

/**
 * Returns the absolute axis-aligned dimensions of the room in metres.
 *
 * Priority order:
 *   1. scene.userData.boundingBox  — set by Model.tsx AFTER centering.
 *      This is the authoritative GLB extent: the exact world-space AABB of the
 *      apartment model with the floor at Y = 0.  No mesh-name heuristics needed.
 *   2. computeRoomBoundingBox      — filtered mesh approach (name regex).
 *   3. whole-scene Box3            — last resort.
 */
export function getRoomDimensions(scene: ThreeScene): RoomDimensions | null {
  function fromBox(box: Box3): Omit<RoomDimensions, "floorArea"> | null {
    const size = new Vector3();
    box.getSize(size);
    if (size.lengthSq() < 0.001) return null;
    return {
      width: +size.x.toFixed(2),
      length: +size.z.toFixed(2),
      height: +size.y.toFixed(2),
    };
  }

  let base: Omit<RoomDimensions, "floorArea"> | null = null;

  // Priority 1 — pre-computed GLB bbox stored by Model.tsx
  scene.traverse((child) => {
    if (!base && child.userData.boundingBox instanceof Box3) {
      base = fromBox(child.userData.boundingBox as Box3);
    }
  });

  // Priority 2 — filtered room-mesh approach
  if (!base) {
    const filtered = computeRoomBoundingBox(scene);
    if (filtered) base = fromBox(filtered.box);
  }

  // Priority 3 — whole-scene bbox
  if (!base) {
    const fullBox = new Box3().setFromObject(scene);
    if (!fullBox.isEmpty()) base = fromBox(fullBox);
  }

  if (!base) return null;
  return { ...base, floorArea: computeFloorArea(scene) };
}

/**
 * Returns a PerspectiveCamera clone of `baseCamera` repositioned to frame the
 * room geometry.
 *
 * • lookAt = volume-weighted centroid (not bbox centre) — stable for
 *   irregular room shapes.
 * • Backs off along the base camera's horizontal direction until the room's
 *   horizontal extent fits the h-FOV with 20 % padding.
 * • Returned camera has fully updated matrices; pass it directly to both
 *   captureSnapshotFromCamera and raycastPixelTo3D.
 *
 * Returns null when no valid room mesh is found.
 */
export function buildOverviewCamera(
  scene: ThreeScene,
  baseCamera: Camera,
  canvasAspect: number
): PerspectiveCamera | null {
  const result = computeRoomBoundingBox(scene);
  if (!result) return null;

  const { box, centroid } = result;

  const size = new Vector3();
  box.getSize(size);
  if (size.lengthSq() < 0.001) return null;

  const fovDeg = (baseCamera as PerspectiveCamera).fov ?? 60;
  const fovRad = (fovDeg * Math.PI) / 180;
  const hFovRad = 2 * Math.atan(Math.tan(fovRad / 2) * canvasAspect);

  const hExtent = Math.max(size.x, size.z);
  const dist = (hExtent / 2 / Math.tan(hFovRad / 2)) * 1.2;

  // Approach from the base camera's horizontal bearing.
  const dir = new Vector3().subVectors(baseCamera.position, centroid);
  dir.y = 0;
  if (dir.lengthSq() < 0.001) dir.set(0, 0, 1);
  dir.normalize();

  const cam = (baseCamera as PerspectiveCamera).clone() as PerspectiveCamera;
  cam.position.set(
    centroid.x + dir.x * dist,
    1.6, // human eye level — never auto-centres on the mesh's vertical midpoint
    centroid.z + dir.z * dist
  );
  // lookAt slightly below eye level so furniture tops are visible in frame.
  const lookTarget = new Vector3(
    centroid.x,
    Math.min(centroid.y, 1.2),
    centroid.z
  );
  cam.lookAt(lookTarget);
  cam.updateMatrixWorld(true);

  console.log(
    `[spatial] Overview cam @ (${cam.position.x.toFixed(
      2
    )}, ${cam.position.y.toFixed(2)}, ${cam.position.z.toFixed(2)}) ` +
      `centroid=(${centroid.x.toFixed(2)}, ${centroid.y.toFixed(
        2
      )}, ${centroid.z.toFixed(2)}) ` +
      `room=${size.x.toFixed(1)}×${size.y.toFixed(1)}×${size.z.toFixed(1)}`
  );

  return cam;
}

// ─── Offscreen snapshot ────────────────────────────────────────────────────────

/**
 * Renders `scene` from `camera` into an offscreen WebGLRenderTarget and
 * returns a JPEG base64 string at the requested CSS pixel dimensions.
 *
 * Advantages over reading gl.domElement directly:
 *   • The main canvas is never modified — no user-visible flash, no restore.
 *   • Zero timing dependency with R3F's render loop: the render target is a
 *     dedicated GPU texture that useFrame callbacks cannot overwrite.
 *   • Transparent / no-geometry pixels are composited onto #808080 so the
 *     output JPEG has no pure-black dead zones that waste vision-model tokens.
 */
export function captureSnapshotFromCamera(
  renderer: WebGLRenderer,
  scene: ThreeScene,
  camera: Camera,
  cssWidth: number,
  cssHeight: number
): { base64: string; mimeType: string; width: number; height: number } {
  // Cap at 720p — preserves aspect ratio, reduces API payload size.
  const MAX_H = 720;
  const scale = cssHeight > MAX_H ? MAX_H / cssHeight : 1;
  const outW = Math.round(cssWidth * scale);
  const outH = Math.round(cssHeight * scale);

  const target = new WebGLRenderTarget(outW, outH);

  const prevTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  renderer.setRenderTarget(prevTarget);

  // Read raw RGBA pixels — WebGL row 0 is the BOTTOM of the image.
  const raw = new Uint8Array(outW * outH * 4);
  renderer.readRenderTargetPixels(target, 0, 0, outW, outH, raw);
  target.dispose();

  // Flip rows: WebGL bottom-to-top → Canvas 2D top-to-bottom.
  const stride = outW * 4;
  const flipped = new Uint8ClampedArray(outW * outH * 4);
  for (let row = 0; row < outH; row++) {
    flipped.set(
      raw.subarray((outH - 1 - row) * stride, (outH - row) * stride),
      row * stride
    );
  }

  // Composite semi-transparent pixels onto neutral mid-gray (#808080).
  for (let i = 0; i < flipped.length; i += 4) {
    const a = flipped[i + 3] / 255;
    if (a < 1) {
      flipped[i] = Math.round(flipped[i] * a + 128 * (1 - a));
      flipped[i + 1] = Math.round(flipped[i + 1] * a + 128 * (1 - a));
      flipped[i + 2] = Math.round(flipped[i + 2] * a + 128 * (1 - a));
      flipped[i + 3] = 255;
    }
  }

  const tmp = document.createElement("canvas");
  tmp.width = outW;
  tmp.height = outH;
  const ctx = tmp.getContext("2d");
  if (!ctx)
    throw new Error("[captureSnapshotFromCamera] cannot get 2D context");
  ctx.putImageData(new ImageData(flipped, outW, outH), 0, 0);

  const dataUrl = tmp.toDataURL("image/jpeg", 0.7);
  return {
    base64: dataUrl.slice(dataUrl.indexOf(",") + 1),
    mimeType: "image/jpeg",
    width: outW,
    height: outH,
  };
}
