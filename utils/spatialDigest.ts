/**
 * Spatial Digest builder — pure client-side computation.
 *
 * Converts calibrated DetectedObject data into a compact SpatialDigest that
 * the chat API can use directly, with no in-prompt arithmetic required.
 */
import type { DetectedObject } from "@/types/auto-discovery";
import type { RoomDimensions }  from "@/utils/spatial";
import type {
  GapEntry,
  ObjectInventoryEntry,
  OccupancyTier,
  PathBlockage,
  SpatialDigest,
  WallClearance,
} from "@/types/spatialDigest";

// ─── Format helpers ───────────────────────────────────────────────────────────

function mToFtIn(m: number): string {
  const totalIn = Math.abs(m) / 0.0254;
  const ft      = Math.floor(totalIn / 12);
  const inches  = Math.round(totalIn % 12);
  return `${ft}′${inches}″`;
}

function fmtM(m: number): string {
  return `${m.toFixed(2)} m (${mToFtIn(m)})`;
}

// ─── Occupancy tier classification ────────────────────────────────────────────

/**
 * Classify a detected object into its occupancy tier.
 *
 * primary      — solid structural volumes that define room clearances
 * secondary    — surface overlays and soft furnishings excluded from gap maths
 * architectural — fixed openings (doors/windows) used only for paths/walls
 */
const ARCHITECTURAL_RE = /\bdoor(?:way)?\b|\bentry\b|\bwindow\b|\barchway\b|\barch\b/i;
const SECONDARY_RE =
  /\brug\b|\bcarpet\b|\bcurtain\b|\bdrape\b|\bblind\b|\bsheer\b|\bmat\b|\bdoormat\b|\blamp\b|\bfloor\s*lamp\b|\btable\s*lamp\b|\bsconce\b|\bpendant\b|\bplant\b|\btree\b|\bpotted\b|\bvase\b|\bornament\b|\bdecor\b|\bpillow\b|\bcushion\b|\bthrow\b|\bblanket\b/i;

export function classifyTier(name: string): OccupancyTier {
  if (ARCHITECTURAL_RE.test(name)) return "architectural";
  if (SECONDARY_RE.test(name))     return "secondary";
  return "primary";
}

// ─── Internal footprint type ──────────────────────────────────────────────────

interface Footprint {
  uid:    string;
  name:   string;
  tier:   OccupancyTier;
  cx:     number;
  cz:     number;
  xMin:   number;
  xMax:   number;
  zMin:   number;
  zMax:   number;
  width:  number;
  depth:  number;
}

function toFootprints(objects: DetectedObject[]): Footprint[] {
  return objects
    .filter((o) => o.dimensions)
    .map((o) => {
      const [cx, , cz] = o.position3D;
      const hw = o.dimensions!.width  / 2;
      const hd = o.dimensions!.depth  / 2;
      return {
        uid:    o.uid,
        name:   o.name,
        tier:   classifyTier(o.name),
        cx, cz,
        xMin: cx - hw, xMax: cx + hw,
        zMin: cz - hd, zMax: cz + hd,
        width: o.dimensions!.width,
        depth: o.dimensions!.depth,
      };
    });
}

// ─── Structural Assembly ───────────────────────────────────────────────────────

/** Objects matching this pattern are eligible for Structural Assembly grouping. */
const ASSEMBLY_RE = /\bbed\b|\bbench\b|\bplatform\b/i;
/** Maximum vertical gap (metres) between two assembleable objects for grouping.
 *  Objects whose bounding boxes are within this vertical distance (gap, not
 *  centre-to-centre) AND overlap in X-Z space are merged into one Spatial Envelope. */
const ASSEMBLY_V_GAP = 0.2;

interface AssemblyCandidate {
  fp:   Footprint;
  yMin: number;
  yMax: number;
}

interface EnvelopeGroup {
  /** Synthetic bounding footprint — replaces individual members in clearance / gap maths. */
  footprint:   Footprint;
  /** UIDs of the constituent objects, used to prune individual footprints. */
  memberUids:  string[];
  /** Human-readable constituent names, used for inventory labels. */
  memberNames: string[];
}

/**
 * Union-find grouping: returns all clusters of `candidates` where each pair
 * in a cluster shares X-Z footprint overlap AND a vertical gap ≤ `vGap` metres.
 */
function groupAssemblyCandidates(
  candidates: AssemblyCandidate[],
  vGap:       number,
): AssemblyCandidate[][] {
  const n      = candidates.length;
  const parent = Array.from({ length: n }, (_, i) => i);

  function find(i: number): number {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = candidates[i], b = candidates[j];
      // Must overlap in both X and Z
      if (a.fp.xMin >= b.fp.xMax || a.fp.xMax <= b.fp.xMin) continue;
      if (a.fp.zMin >= b.fp.zMax || a.fp.zMax <= b.fp.zMin) continue;
      // Vertical gap: positive = gap between bounding boxes, negative = overlap
      const vertGap = Math.max(a.yMin, b.yMin) - Math.min(a.yMax, b.yMax);
      if (vertGap > vGap) continue;
      const pa = find(i), pb = find(j);
      if (pa !== pb) parent[pa] = pb;
    }
  }

  const map = new Map<number, AssemblyCandidate[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!map.has(root)) map.set(root, []);
    map.get(root)!.push(candidates[i]);
  }
  return [...map.values()];
}

/**
 * Builds Structural Envelopes for Bed / Bench / Platform objects that are
 * vertically adjacent (gap ≤ ASSEMBLY_V_GAP) AND overlap in X-Z space.
 * Single isolated objects are not enveloped.
 *
 * The resulting envelope footprint is the total axis-aligned bounding box of
 * the group — it replaces the individual member footprints in all clearance and
 * gap calculations, so the combined occupied floor area is used rather than
 * just the mattress or bench surface alone.
 */
function buildStructuralEnvelopes(
  objects: DetectedObject[],
  fps:     Footprint[],
): EnvelopeGroup[] {
  const candidates: AssemblyCandidate[] = objects
    .filter((o) => o.dimensions && ASSEMBLY_RE.test(o.name))
    .flatMap((o) => {
      const fp = fps.find((f) => f.uid === o.uid);
      if (!fp) return [];
      const yMid = o.position3D[1];
      const hh   = o.dimensions!.height / 2;
      return [{ fp, yMin: yMid - hh, yMax: yMid + hh }];
    });

  if (candidates.length < 2) return [];

  const groups = groupAssemblyCandidates(candidates, ASSEMBLY_V_GAP);
  return groups
    .filter((g) => g.length > 1)
    .map((g) => {
      const xMin  = Math.min(...g.map((a) => a.fp.xMin));
      const xMax  = Math.max(...g.map((a) => a.fp.xMax));
      const zMin  = Math.min(...g.map((a) => a.fp.zMin));
      const zMax  = Math.max(...g.map((a) => a.fp.zMax));
      const cx    = (xMin + xMax) / 2;
      const cz    = (zMin + zMax) / 2;
      const names = g.map((a) => a.fp.name);
      const footprint: Footprint = {
        uid:   `__env__${g.map((a) => a.fp.uid).join("_")}`,
        name:  `Structural Envelope (${names.join(" + ")})`,
        tier:  "primary",
        cx, cz,
        xMin, xMax, zMin, zMax,
        width: +(xMax - xMin).toFixed(3),
        depth: +(zMax - zMin).toFixed(3),
      };
      return { footprint, memberUids: g.map((a) => a.fp.uid), memberNames: names };
    });
}

// ─── Structural Healing — digest-only centroid snapping ───────────────────────

/**
 * Matches pure bed objects.  We explicitly exclude "platform" so that
 * "bed platform" objects fall into SNAP_PLATFORM_RE instead.
 */
const SNAP_BED_RE      = /\bbed\b/i;
const SNAP_PLATFORM_RE = /\bplatform\b/i;
/** Maximum XZ centroid distance (metres) for two objects to be snap-eligible. */
const SNAP_CENTROID_MAX_M = 0.5;

interface SnapResult {
  fps:        Footprint[];
  healedUids: string[];
}

/**
 * Label-Specific Snapping — digest-only.
 *
 * For each `bed` / `bed platform` pair whose XZ centroids are within
 * SNAP_CENTROID_MAX_M, both footprints are re-centred to the average of their
 * centroids.  Individual widths and depths are preserved; only cx/cz and the
 * derived bounding edges change.
 *
 * This corrects scan-induced centroid drift so gap and clearance maths use a
 * physically coherent layout.  The underlying store objects are never touched.
 */
function snapStackedObjects(fps: Footprint[]): SnapResult {
  // Pure bed objects (exclude "bed platform")
  const beds      = fps.filter((f) =>  SNAP_BED_RE.test(f.name) && !SNAP_PLATFORM_RE.test(f.name));
  // Platform objects (includes "bed platform"; may or may not also match SNAP_BED_RE)
  const platforms = fps.filter((f) =>  SNAP_PLATFORM_RE.test(f.name));

  if (beds.length === 0 || platforms.length === 0) return { fps, healedUids: [] };

  const overrides  = new Map<string, Partial<Footprint>>();

  for (const bed of beds) {
    for (const plat of platforms) {
      if (bed.uid === plat.uid) continue;
      const dx   = bed.cx - plat.cx;
      const dz   = bed.cz - plat.cz;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > SNAP_CENTROID_MAX_M) continue;

      const avgCx = (bed.cx  + plat.cx)  / 2;
      const avgCz = (bed.cz  + plat.cz)  / 2;

      overrides.set(bed.uid, {
        cx:   avgCx,
        cz:   avgCz,
        xMin: avgCx - bed.width  / 2,
        xMax: avgCx + bed.width  / 2,
        zMin: avgCz - bed.depth  / 2,
        zMax: avgCz + bed.depth  / 2,
      });
      overrides.set(plat.uid, {
        cx:   avgCx,
        cz:   avgCz,
        xMin: avgCx - plat.width  / 2,
        xMax: avgCx + plat.width  / 2,
        zMin: avgCz - plat.depth  / 2,
        zMax: avgCz + plat.depth  / 2,
      });

      console.log(
        `[SpatialDigest] Snap: "${bed.name}" + "${plat.name}" ` +
        `Δ${dist.toFixed(3)} m → avg (${avgCx.toFixed(3)}, ${avgCz.toFixed(3)})`,
      );
    }
  }

  if (overrides.size === 0) return { fps, healedUids: [] };

  return {
    fps: fps.map((f) => {
      const patch = overrides.get(f.uid);
      return patch ? { ...f, ...patch } : f;
    }),
    healedUids: [...overrides.keys()],
  };
}

// ─── Co-planar Growth ─────────────────────────────────────────────────────────

const BED_RE_DIGEST = /\bbed\b/i;
/** Minimum fraction of a bed's footprint area that a candidate base must cover. */
const BASE_OVERLAP_MIN = 0.50;

/**
 * Returns the non-bed footprint with the largest depth that covers ≥ BASE_OVERLAP_MIN
 * of `bedFp`'s area — i.e. a platform, storage base, or built-in structure the
 * bed is sitting on top of.  Returns undefined when no such base exists.
 */
function findCoplanarBase(bedFp: Footprint, allFps: Footprint[]): Footprint | undefined {
  const bedArea = bedFp.width * bedFp.depth;
  if (bedArea <= 0) return undefined;

  let best: Footprint | undefined;
  for (const fp of allFps) {
    if (fp.uid === bedFp.uid)             continue;
    if (BED_RE_DIGEST.test(fp.name))      continue;
    if (fp.tier === "architectural")      continue;
    if (fp.depth <= bedFp.depth)          continue; // must be deeper than the bed itself

    const xOverlap   = Math.max(0, Math.min(bedFp.xMax, fp.xMax) - Math.max(bedFp.xMin, fp.xMin));
    const zOverlap   = Math.max(0, Math.min(bedFp.zMax, fp.zMax) - Math.max(bedFp.zMin, fp.zMin));
    const overlapFrac = (xOverlap * zOverlap) / bedArea;
    if (overlapFrac < BASE_OVERLAP_MIN) continue;

    if (!best || fp.depth > best.depth) best = fp;
  }
  return best;
}

// ─── Inventory — every object, regardless of tier ─────────────────────────────

/**
 * Builds the full room inventory so the AI "sees" every detected object.
 * Objects without a measured footprint are still listed as pending.
 *
 * @param depthOverrides  Map of uid → adjusted depth (metres) for co-planar growth.
 *                        When a bed sits on a larger base mass, its Spatial Digest
 *                        depth is replaced with the base mass's depth here.
 */
function computeInventory(
  objects:        DetectedObject[],
  depthOverrides: Map<string, number> = new Map(),
): ObjectInventoryEntry[] {
  return objects.map((o) => {
    const tier    = classifyTier(o.name);
    const hasDims = !!o.dimensions;
    const w = o.dimensions?.width;
    const h = o.dimensions?.height;
    // Use co-planar base depth when available, otherwise measured depth
    const d = depthOverrides.get(o.uid) ?? o.dimensions?.depth;

    const map = hasDims
      ? {
          x: +o.position3D[0].toFixed(3),
          z: +o.position3D[2].toFixed(3),
          w: +w!.toFixed(3),
          d: +d!.toFixed(3),
        }
      : undefined;

    let label: string;
    if (!hasDims) {
      label =
        `${o.name} [${tier}] @ (${o.position3D[0].toFixed(2)}, ${o.position3D[2].toFixed(2)}) ` +
        `— footprint pending fresh measurement`;
    } else {
      label =
        `${o.name} [${tier}]: ${w!.toFixed(2)} m wide × ${d!.toFixed(2)} m deep × ${h!.toFixed(2)} m tall` +
        ` | map x=${map!.x} z=${map!.z}`;
    }

    return {
      name:        o.name,
      tier,
      width:       w,
      height:      h,
      depth:       d,
      pendingScan: !hasDims,
      map,
      label,
    };
  });
}

// ─── Object gap computation (primary tier only) ───────────────────────────────

/**
 * Computes clearances between PRIMARY-tier objects only.
 * Secondary overlays (rugs, curtains, lamps) are excluded so their geometry
 * never contaminates sofa-to-table clearance readings.
 *
 * Gaps > 3 m are omitted — too far apart to matter for room-flow advice.
 */
function computeObjectGaps(fps: Footprint[]): GapEntry[] {
  // Only primary volumes participate in gap calculations
  const primary = fps.filter((f) => f.tier === "primary");
  const gaps: GapEntry[] = [];

  for (let i = 0; i < primary.length; i++) {
    for (let j = i + 1; j < primary.length; j++) {
      const a = primary[i];
      const b = primary[j];

      // ── Side-to-side (X axis) gap ──────────────────────────────────────────
      {
        const [left, right] = a.xMax <= b.xMin ? [a, b] : [b, a];
        if (left.xMax <= right.xMin) {
          const gapX     = right.xMin - left.xMax;
          const zOverlap = Math.min(left.zMax, right.zMax) - Math.max(left.zMin, right.zMin);
          if (gapX < 3.0 && zOverlap > 0) {
            gaps.push({
              between:   [left.name, right.name],
              gapMetres: +gapX.toFixed(3),
              axis:      "x",
              label:     `${left.name} ↔ ${right.name} (side-to-side): ${fmtM(gapX)}`,
            });
          }
        }
      }

      // ── Walkway (Z axis) gap ───────────────────────────────────────────────
      {
        const [front, back] = a.zMax <= b.zMin ? [a, b] : [b, a];
        if (front.zMax <= back.zMin) {
          const gapZ     = back.zMin - front.zMax;
          const xOverlap = Math.min(front.xMax, back.xMax) - Math.max(front.xMin, back.xMin);
          if (gapZ < 3.0 && xOverlap > 0) {
            gaps.push({
              between:   [front.name, back.name],
              gapMetres: +gapZ.toFixed(3),
              axis:      "z",
              label:     `${front.name} ↔ ${back.name} (walkway): ${fmtM(gapZ)}`,
            });
          }
        }
      }
    }
  }

  return gaps;
}

// ─── Wall clearance computation ───────────────────────────────────────────────

const WALL_PROXIMITY = 0.5; // metres — how close an object must be to count as "against" a wall

function computeWallClearances(fps: Footprint[], rd: RoomDimensions): WallClearance[] {
  const halfW = rd.width  / 2;
  const halfL = rd.length / 2;

  // Primary + secondary objects both occupy wall space; only architectural
  // openings are treated separately as door spans.
  const walls: Array<{
    name:    WallClearance["wall"];
    wallLen: number;
    near:    (f: Footprint) => boolean;
    span:    (f: Footprint) => number;
  }> = [
    { name: "north", wallLen: rd.width,  near: (f) => f.zMin <= -halfL + WALL_PROXIMITY, span: (f) => f.width },
    { name: "south", wallLen: rd.width,  near: (f) => f.zMax >=  halfL - WALL_PROXIMITY, span: (f) => f.width },
    { name: "east",  wallLen: rd.length, near: (f) => f.xMax >=  halfW - WALL_PROXIMITY, span: (f) => f.depth },
    { name: "west",  wallLen: rd.length, near: (f) => f.xMin <= -halfW + WALL_PROXIMITY, span: (f) => f.depth },
  ];

  return walls.map((w) => {
    const furniture  = fps.filter((f) => f.tier !== "architectural" && w.near(f));
    const doorSpan   = fps.filter((f) => f.tier === "architectural" && w.near(f))
                         .reduce((s, d) => s + w.span(d), 0);
    const objSpan    = furniture.reduce((s, f) => s + w.span(f), 0);
    const rawRemaining = w.wallLen - objSpan - doorSpan;

    // 15 cm Wall Rule: clamp sub-threshold gaps to zero so the AI never
    // receives a misleading "0.08 m available" when furniture is flush.
    const isTouchingWall = rawRemaining < 0.15;
    const remaining      = isTouchingWall ? 0.0 : rawRemaining;
    const atCapacity     = remaining < 0.3;

    return {
      wall:  w.name,
      remaining: +remaining.toFixed(3),
      atCapacity,
      isTouchingWall,
      label: isTouchingWall
        ? `${w.name} wall: furniture flush against wall (≤ 15 cm gap clamped to 0)`
        : atCapacity
        ? `${w.name} wall is at functional capacity (${fmtM(remaining)} remaining)`
        : `${w.name} wall has ${fmtM(remaining)} available`,
    };
  });
}

// ─── Path blockage computation ────────────────────────────────────────────────

/**
 * For each detected door, checks whether any primary-tier furniture intrudes
 * into the 0.9 m-wide corridor between the door and the room centre (0, 0).
 * Secondary objects (rugs etc.) are intentionally ignored here — a rug does
 * not block a walking path in the same way a sofa does.
 */
function computePathBlockages(fps: Footprint[]): PathBlockage[] {
  const CORRIDOR_HALF = 0.45; // half of the 0.9 m min walkway

  return fps
    .filter((f) => f.tier === "architectural" && /door/i.test(f.name))
    .map((door) => {
      // Only primary volumes block a walking path
      const furniture = fps.filter((f) => f.tier === "primary");

      const pathXMin = Math.min(door.cx, 0) - CORRIDOR_HALF;
      const pathXMax = Math.max(door.cx, 0) + CORRIDOR_HALF;
      const pathZMin = Math.min(door.cz, 0);
      const pathZMax = Math.max(door.cz, 0);

      const blockers = furniture.filter(
        (f) => f.xMin < pathXMax && f.xMax > pathXMin &&
               f.zMin < pathZMax && f.zMax > pathZMin
      );

      if (blockers.length === 0) {
        return {
          door:          door.name,
          blocked:       false,
          pathClearance: 0.9,
          label:         `Path from ${door.name} is clear`,
        };
      }

      const nearest = blockers.reduce((best, b) => {
        const gap = Math.abs(b.zMin - door.zMax);
        return gap < best ? gap : best;
      }, Infinity);

      const clearance = Math.max(0, nearest);
      const blocked   = clearance < 0.9;

      return {
        door:         door.name,
        blocked,
        obstruction:  blocked ? blockers[0].name : undefined,
        pathClearance: +clearance.toFixed(3),
        label: blocked
          ? `Path from ${door.name} is narrowed by ${blockers[0].name} (${fmtM(clearance)} clear)`
          : `Path from ${door.name} is open (${fmtM(clearance)} clearance)`,
      };
    });
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function buildSpatialDigest(
  objects:        DetectedObject[],
  roomDimensions: RoomDimensions | null,
): SpatialDigest {
  const rawFps = toFootprints(objects);

  // ── Structural Healing (digest-only) ────────────────────────────────────
  // Snap bed + platform centroid drift before any geometric computation so
  // that gap, clearance, and path-blockage results are physically coherent.
  // The store objects are NEVER mutated here.
  const { fps, healedUids } = snapStackedObjects(rawFps);

  // ── Parent-Child Relationships ────────────────────────────────────────────
  // Use the (possibly healed) footprints for co-planar base detection so
  // relationship labels also reflect the corrected layout.
  const childToParent = new Map<string, string>(); // child uid → parent name
  const parentToChild = new Map<string, string>(); // parent uid → child name

  for (const fp of fps) {
    if (!BED_RE_DIGEST.test(fp.name)) continue;
    const base = findCoplanarBase(fp, fps);
    if (!base) continue;
    childToParent.set(fp.uid, base.name);
    parentToChild.set(base.uid, fp.name);
    console.log(
      `[SpatialDigest] Parent-child link: "${fp.name}" → "${base.name}" ` +
      `(child depth=${fp.depth.toFixed(2)}m, parent depth=${base.depth.toFixed(2)}m).`,
    );
  }

  // Inventory — individual objects only; relationship + healing notes on labels.
  const inventory = computeInventory(objects);

  // Map uid → inventory index so we can annotate in O(n)
  const uidToIdx = new Map(objects.map((o, i) => [o.uid, i]));

  for (const [uid, parentName] of childToParent) {
    const idx = uidToIdx.get(uid);
    if (idx != null) {
      inventory[idx] = {
        ...inventory[idx],
        label: inventory[idx].label + ` | on ${parentName}`,
      };
    }
  }
  for (const [uid, childName] of parentToChild) {
    const idx = uidToIdx.get(uid);
    if (idx != null) {
      inventory[idx] = {
        ...inventory[idx],
        label: inventory[idx].label + ` | supports ${childName}`,
      };
    }
  }
  // Annotate healed objects so the AI (and dashboard) can see the correction.
  for (const uid of healedUids) {
    const idx = uidToIdx.get(uid);
    if (idx != null) {
      inventory[idx] = {
        ...inventory[idx],
        label: inventory[idx].label + ` | [centroid healed — digest-only]`,
      };
    }
  }

  return {
    inventory,
    objectGaps:     computeObjectGaps(fps),
    wallClearances: roomDimensions ? computeWallClearances(fps, roomDimensions) : [],
    pathBlockages:  computePathBlockages(fps),
    healedUids:     healedUids.length > 0 ? healedUids : undefined,
  };
}

/**
 * Stable fingerprint for the latency guard.
 * Returns a new string only when object dimensions/positions or room dims change.
 * Safe to compare with `===` in a useEffect dependency or Zustand set guard.
 */
export function digestFingerprint(
  objects:        DetectedObject[],
  roomDimensions: RoomDimensions | null,
): string {
  const objSig = objects
    .map((o) =>
      `${o.uid}:` +
      `${o.dimensions?.width?.toFixed(3) ?? "?"}x` +
      `${o.dimensions?.depth?.toFixed(3) ?? "?"}@` +
      `${o.position3D[0].toFixed(2)},${o.position3D[2].toFixed(2)}`
    )
    .join("|");
  const rdSig = roomDimensions
    ? `${roomDimensions.width.toFixed(3)}x${roomDimensions.length.toFixed(3)}`
    : "none";
  return `${objSig}@${rdSig}`;
}
