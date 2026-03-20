/**
 * Spatial Digest builder — pure client-side computation.
 *
 * Converts calibrated DetectedObject data into a compact SpatialDigest that
 * the chat API can use directly, with no in-prompt arithmetic required.
 */
import type { DetectedObject } from "@/types/auto-discovery";
import type { RoomDimensions }  from "@/utils/spatial";
import { runValidationLoop, generateSpatialHealthReport } from "@/utils/semanticScale";
import { STANDARD_ANCHORS } from "@/data/standardAnchors";
import type {
  GapEntry,
  ObjectInventoryEntry,
  OccupancyTier,
  PathBlockage,
  SpatialDigest,
  TransitionPortal,
  WallClearance,
  Zone,
  ZoneCalibrationMap,
  ZoneMap,
  ZoneType,
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

// ─── Hybrid Zoning System ─────────────────────────────────────────────────────

// ── Zone classification regexes ──
const ZONE_KITCHEN_RE = /\brefrigerator\b|\bfridge\b|\bsink\b|\bdishwasher\b|\boven\b|\bstove\b|\bmicrowave\b|\bcountertop\b|\bcounter\b/i;
const ZONE_LIVING_RE  = /\bsofa\b|\bcouch\b|\bsectional\b|\btelevision\b|\btv\b|\barmchair\b/i;
const ZONE_BED_RE     = /\bbed\b/i;

/** Buffer (m) added to each zone AABB beyond its outermost object footprint. */
const ZONE_BOUNDS_BUFFER_M   = 0.35;
/** AABB aspect ratio above which a zone is classified as a hallway. */
const HALLWAY_ASPECT_RATIO   = 3.0;
/** Minimum fallback gap (m) required to split when no type-boundary gap is found. */
const SPLIT_FALLBACK_GAP_M   = 0.3;

/**
 * Derives the zone clustering radius from room dimensions when available.
 * Uses 35% of the shorter room dimension as the merge threshold, so the
 * clustering adapts to the actual space rather than using a fixed 2 m constant.
 * Falls back to 1.5 m when no room context is provided.
 */
function deriveClusterRadius(rd: { width: number; length: number } | null): number {
  if (!rd) return 1.5;
  return Math.max(0.8, Math.min(3.0, Math.min(rd.width, rd.length) * 0.35));
}

// ── Architectural Anchor helpers ──

/** Regex matching all kitchen-specific architectural anchors. */
const KITCHEN_ANCHOR_RE = /\brefrigerator\b|\bfridge\b|\bstove\b|\brange\b|\bsink\b|\bcabinet\b/i;

/** Returns true if `name` matches any StandardAnchor flagged as an architectural anchor. */
function matchesArchitecturalAnchor(name: string): boolean {
  return STANDARD_ANCHORS.some((a) => a.isArchitecturalAnchor && a.pattern.test(name));
}

/**
 * Calculates kitchen width: the clear floor distance from the front face of the
 * cabinet bank to the opposite room wall.  Returns undefined when no cabinet is
 * present in the zone or room dimensions are unavailable.
 */
function computeKitchenWidth(zoneFps: Footprint[], rd: RoomDimensions): number | undefined {
  const halfW = rd.width  / 2;
  const halfL = rd.length / 2;

  const cabinets = zoneFps.filter((f) => /\bcabinet\b/i.test(f.name));
  if (cabinets.length === 0) return undefined;

  let bestWidth: number | undefined;
  let smallestGap = Infinity;

  for (const cab of cabinets) {
    // For each wall, compute (gap to wall, clearance to opposite wall).
    // The cabinet is "on" whichever wall has the smallest gap.
    const candidates = [
      { gap: cab.zMin + halfL, width: halfL - cab.zMax },  // cabinet on north wall
      { gap: halfL - cab.zMax, width: cab.zMin + halfL },  // cabinet on south wall
      { gap: halfW - cab.xMax, width: cab.xMin + halfW },  // cabinet on east wall
      { gap: cab.xMin + halfW, width: halfW - cab.xMax },  // cabinet on west wall
    ];
    const nearest = candidates.reduce((a, b) => a.gap < b.gap ? a : b);
    if (nearest.gap < smallestGap) {
      smallestGap = nearest.gap;
      bestWidth   = Math.max(0, nearest.width);
    }
  }

  return bestWidth != null ? +bestWidth.toFixed(3) : undefined;
}

// ── Zone type helpers ──

function getZoneType(names: string[], isHallway: boolean): ZoneType {
  if (isHallway) return "hallway";
  const hasBed     = names.some((n) => ZONE_BED_RE.test(n));
  const hasKitchen = names.some((n) => ZONE_KITCHEN_RE.test(n));
  const hasLiving  = names.some((n) => ZONE_LIVING_RE.test(n));
  if (hasBed)     return "bedroom";
  if (hasKitchen) return "kitchen";
  if (hasLiving)  return "living";
  return "unclassified";
}

function getZoneLabel(type: ZoneType, fallbackIdx: number): string {
  switch (type) {
    case "bedroom":       return "Bedroom";
    case "kitchen":       return "Kitchen";
    case "living":        return "Living Room";
    case "hallway":       return "Hallway";
    case "living_bedroom": return "Living/Bedroom Area";
    default:              return `Room ${String.fromCharCode(65 + fallbackIdx)}`; // Room A, B, …
  }
}

// ── AABB helpers ──

function boundsOf(
  fps:    Footprint[],
  buffer: number = ZONE_BOUNDS_BUFFER_M,
): { xMin: number; xMax: number; zMin: number; zMax: number } {
  return {
    xMin: Math.min(...fps.map((f) => f.xMin)) - buffer,
    xMax: Math.max(...fps.map((f) => f.xMax)) + buffer,
    zMin: Math.min(...fps.map((f) => f.zMin)) - buffer,
    zMax: Math.max(...fps.map((f) => f.zMax)) + buffer,
  };
}

// ── Union-find clustering by centroid proximity ──

function clusterByProximity(fps: Footprint[], radiusM = 1.5): Footprint[][] {
  const n      = fps.length;
  const parent = Array.from({ length: n }, (_, i) => i);

  function find(i: number): number {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = fps[i].cx - fps[j].cx;
      const dz = fps[i].cz - fps[j].cz;
      if (Math.sqrt(dx * dx + dz * dz) <= radiusM) {
        const pi = find(i), pj = find(j);
        if (pi !== pj) parent[pi] = pj;
      }
    }
  }

  const map = new Map<number, Footprint[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!map.has(root)) map.set(root, []);
    map.get(root)!.push(fps[i]);
  }
  return [...map.values()];
}

// ── Nearest-zone assignment for non-primary objects ──

function nearestZoneId(
  fp:    Footprint,
  zones: ReadonlyArray<{ id: string; bounds: { xMin: number; xMax: number; zMin: number; zMax: number } }>,
): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;
  for (const z of zones) {
    const cx = (z.bounds.xMin + z.bounds.xMax) / 2;
    const cz = (z.bounds.zMin + z.bounds.zMax) / 2;
    const d  = Math.sqrt((fp.cx - cx) ** 2 + (fp.cz - cz) ** 2);
    if (d < bestDist) { bestDist = d; best = z.id; }
  }
  return best;
}

// ── Cluster Density Map — diagnostic logging ──

/**
 * Logs every cluster's centroid and member centroids, then reports the minimum
 * inter-object distance between every pair of clusters.  Called inside
 * buildZoneMap after Object-Aware Splitting so the log reflects the final
 * cluster layout that feeds zone classification.
 */
function logClusterDensityMap(clusters: Footprint[][]): void {
  console.log("[ZoneEngine] ── Cluster Density Map ──────────────────────────────────");
  clusters.forEach((cluster, idx) => {
    const cx = cluster.reduce((s, f) => s + f.cx, 0) / cluster.length;
    const cz = cluster.reduce((s, f) => s + f.cz, 0) / cluster.length;
    console.log(
      `  Cluster ${idx} [${cluster.length} object${cluster.length !== 1 ? "s" : ""}]` +
      ` centroid: (${cx.toFixed(2)}, ${cz.toFixed(2)})`,
    );
    for (const f of cluster) {
      console.log(`    • ${f.name}: cx=${f.cx.toFixed(2)}, cz=${f.cz.toFixed(2)}`);
    }
  });

  if (clusters.length > 1) {
    console.log("[ZoneEngine] ── Inter-Cluster Gaps ──────────────────────────────────");
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        let minDist = Infinity;
        let pairA = "", pairB = "";
        for (const a of clusters[i]) {
          for (const b of clusters[j]) {
            const d = Math.sqrt((a.cx - b.cx) ** 2 + (a.cz - b.cz) ** 2);
            if (d < minDist) { minDist = d; pairA = a.name; pairB = b.name; }
          }
        }
        console.log(
          `  Cluster ${i} ↔ Cluster ${j}: min gap = ${minDist.toFixed(2)} m` +
          ` ("${pairA}" ↔ "${pairB}")`,
        );
      }
    }
  }
}

// ── Object-Aware Fused-Zone Splitting ──

/**
 * Classifies an object by its dominant functional family.
 *   'appliance'  — kitchen fixtures: fridge, stove, sink, cabinet, etc.
 *   'seating'    — living room anchors: sofa, tv, armchair, etc.
 *   'sleeping'   — bedroom: bed.
 *   'other'      — dining table, lamp, rug, unclassified.
 */
function getFunctionalFamily(name: string): "appliance" | "seating" | "sleeping" | "other" {
  if (KITCHEN_ANCHOR_RE.test(name) || ZONE_KITCHEN_RE.test(name)) return "appliance";
  if (ZONE_LIVING_RE.test(name))  return "seating";
  if (ZONE_BED_RE.test(name))     return "sleeping";
  return "other";
}

/**
 * Semantic Cluster Gap algorithm — splits clusters whose members belong to
 * different functional families (e.g. appliances + seating in an open-plan).
 *
 * Unlike the old threshold-based approach, this algorithm:
 *  1. Identifies the dominant axis (largest centroid spread).
 *  2. Finds the LARGEST GAP that also crosses a functional-family boundary.
 *     → No hard-coded distance minimum — a type transition is the trigger.
 *  3. Falls back to the largest unconditional gap if no type-boundary gap is
 *     found but the cluster is still semantically mixed, clamped at a small
 *     noise floor (SPLIT_FALLBACK_GAP_M = 0.3 m).
 *
 * Returns a new cluster array; unambiguous clusters pass through unchanged.
 */
function splitFusedClusters(clusters: Footprint[][]): Footprint[][] {
  const result: Footprint[][] = [];

  for (const cluster of clusters) {
    if (cluster.length < 2) { result.push(cluster); continue; }

    // Pass through clusters that are functionally homogeneous
    const families = new Set(cluster.map((f) => getFunctionalFamily(f.name)));
    if (families.size <= 1) { result.push(cluster); continue; }

    // Determine dominant axis by centroid spread
    const xSpan = Math.max(...cluster.map((f) => f.cx)) - Math.min(...cluster.map((f) => f.cx));
    const zSpan = Math.max(...cluster.map((f) => f.cz)) - Math.min(...cluster.map((f) => f.cz));
    const axis: "cx" | "cz" = xSpan >= zSpan ? "cx" : "cz";

    const sorted = [...cluster].sort((a, b) => a[axis] - b[axis]);

    // Phase 1 — find the largest gap that straddles a type-family boundary
    let maxTypeBoundaryGap = -1;
    let splitAfter         = -1;
    for (let i = 0; i < sorted.length - 1; i++) {
      const famA = getFunctionalFamily(sorted[i].name);
      const famB = getFunctionalFamily(sorted[i + 1].name);
      if (famA === famB) continue;
      const gap = sorted[i + 1][axis] - sorted[i][axis];
      if (gap > maxTypeBoundaryGap) { maxTypeBoundaryGap = gap; splitAfter = i; }
    }

    // Phase 2 — fallback: largest gap between any consecutive pair, noise-floored
    if (splitAfter < 0) {
      let maxFallbackGap = 0;
      for (let i = 0; i < sorted.length - 1; i++) {
        const gap = sorted[i + 1][axis] - sorted[i][axis];
        if (gap > maxFallbackGap) { maxFallbackGap = gap; splitAfter = i; }
      }
      if (maxFallbackGap < SPLIT_FALLBACK_GAP_M) { result.push(cluster); continue; }
      maxTypeBoundaryGap = maxFallbackGap;
    }

    const midpoint = (sorted[splitAfter][axis] + sorted[splitAfter + 1][axis]) / 2;
    const clusterA = sorted.filter((f) => f[axis] <= midpoint);
    const clusterB = sorted.filter((f) => f[axis] >  midpoint);

    const axisLabel  = axis === "cx" ? "X" : "Z";
    const famBefore  = getFunctionalFamily(sorted[splitAfter].name);
    const famAfter   = getFunctionalFamily(sorted[splitAfter + 1].name);
    const boundaryType = famBefore !== famAfter ? `${famBefore}→${famAfter}` : "fallback";

    console.log(
      `[ZoneEngine] Semantic Cluster Gap Split on ${axisLabel} — ` +
      `boundary: ${boundaryType}, gap=${maxTypeBoundaryGap.toFixed(2)}m at midpoint=${midpoint.toFixed(2)}m. ` +
      `[${clusterA.map((f) => f.name).join(", ")}] | [${clusterB.map((f) => f.name).join(", ")}]`,
    );
    result.push(clusterA, clusterB);
  }

  return result;
}

// ── Geometric Aperture Scan — Transition Portal detection ──

/**
 * Scans adjacent zone AABB pairs for gaps that qualify as Transition Portals
 * (corridors / doorways between zones).
 *
 * Replaces the hard-coded [0.8, 1.2 m] range with proportional thresholds
 * derived from the zones' own dimensions:
 *   portalMin = smaller zone's gap-axis span × 0.06  (not just touching)
 *   portalMax = smaller zone's gap-axis span × 0.40  (narrower than open-plan)
 *
 * The gap must also overlap on the perpendicular axis to qualify as a
 * physical connection rather than two completely separate rooms.
 */
function detectTransitionPortals(
  zones: ReadonlyArray<{ id: string; bounds: { xMin: number; xMax: number; zMin: number; zMax: number } }>,
): TransitionPortal[] {
  const portals: TransitionPortal[] = [];

  for (let i = 0; i < zones.length; i++) {
    for (let j = i + 1; j < zones.length; j++) {
      const a  = zones[i].bounds, b = zones[j].bounds;
      const za = zones[i].id,     zb = zones[j].id;

      // X-axis gap (zones are side-by-side; corridor runs N-S)
      const xGap = a.xMin > b.xMax ? a.xMin - b.xMax
                 : b.xMin > a.xMax ? b.xMin - a.xMax
                 : 0;
      const zOverlap = Math.min(a.zMax, b.zMax) - Math.max(a.zMin, b.zMin);
      if (xGap > 0 && zOverlap > 0) {
        const xSpanA   = a.xMax - a.xMin, xSpanB = b.xMax - b.xMin;
        const refX     = Math.min(xSpanA, xSpanB);
        const minPortal = refX * 0.06, maxPortal = refX * 0.40;
        if (xGap >= minPortal && xGap <= maxPortal) {
          portals.push({ between: [za, zb], axis: "x", widthM: +xGap.toFixed(3) });
        } else {
          const why = xGap < minPortal
            ? `too narrow (${xGap.toFixed(2)} m < ${minPortal.toFixed(2)} m proportional min)`
            : `too wide (${xGap.toFixed(2)} m > ${maxPortal.toFixed(2)} m — open-plan span)`;
          console.log(`[ZoneEngine] Portal rejected [${za}↔${zb}] X-axis: ${why}`);
        }
      }

      // Z-axis gap (zones are front-to-back; corridor runs E-W)
      const zGap = a.zMin > b.zMax ? a.zMin - b.zMax
                 : b.zMin > a.zMax ? b.zMin - a.zMax
                 : 0;
      const xOverlap = Math.min(a.xMax, b.xMax) - Math.max(a.xMin, b.xMin);
      if (zGap > 0 && xOverlap > 0) {
        const zSpanA   = a.zMax - a.zMin, zSpanB = b.zMax - b.zMin;
        const refZ     = Math.min(zSpanA, zSpanB);
        const minPortal = refZ * 0.06, maxPortal = refZ * 0.40;
        if (zGap >= minPortal && zGap <= maxPortal) {
          portals.push({ between: [za, zb], axis: "z", widthM: +zGap.toFixed(3) });
        } else {
          const why = zGap < minPortal
            ? `too narrow (${zGap.toFixed(2)} m < ${minPortal.toFixed(2)} m proportional min)`
            : `too wide (${zGap.toFixed(2)} m > ${maxPortal.toFixed(2)} m — open-plan span)`;
          console.log(`[ZoneEngine] Portal rejected [${za}↔${zb}] Z-axis: ${why}`);
        }
      }
    }
  }

  return portals;
}

// ── Zone-local wall clearances ──

/**
 * Computes wall clearances using ONLY the objects within a zone and ONLY the
 * room walls whose plane is within ZONE_WALL_ADJACENCY_M of the zone AABB.
 * This prevents, e.g., kitchen wall distances appearing in a living-room answer.
 */
function computeZoneWallClearances(
  zoneFps: Footprint[],
  bounds:  { xMin: number; xMax: number; zMin: number; zMax: number },
  rd:      RoomDimensions,
): WallClearance[] {
  const halfW = rd.width  / 2;
  const halfL = rd.length / 2;

  // Use the zone's own span as the "wall length" so clearances are relative to
  // the zone footprint, not the full room.
  const spanNS = bounds.xMax - bounds.xMin; // N + S walls run along X
  const spanEW = bounds.zMax - bounds.zMin; // E + W walls run along Z

  const wallDefs: Array<{
    name:     WallClearance["wall"];
    wallLen:  number;
    near:     (f: Footprint) => boolean;
    span:     (f: Footprint) => number;
    adjacent: boolean;
  }> = [
    {
      name: "north", wallLen: spanNS,
      near: (f) => f.zMin <= -halfL + WALL_PROXIMITY,
      span: (f) => f.width,
      adjacent: bounds.zMin <= -halfL + spanEW * 0.5,
    },
    {
      name: "south", wallLen: spanNS,
      near: (f) => f.zMax >=  halfL - WALL_PROXIMITY,
      span: (f) => f.width,
      adjacent: bounds.zMax >=  halfL - spanEW * 0.5,
    },
    {
      name: "east", wallLen: spanEW,
      near: (f) => f.xMax >=  halfW - WALL_PROXIMITY,
      span: (f) => f.depth,
      adjacent: bounds.xMax >=  halfW - spanNS * 0.5,
    },
    {
      name: "west", wallLen: spanEW,
      near: (f) => f.xMin <= -halfW + WALL_PROXIMITY,
      span: (f) => f.depth,
      adjacent: bounds.xMin <= -halfW + spanNS * 0.5,
    },
  ];

  return wallDefs
    .filter((w) => w.adjacent)
    .map((w) => {
      const furniture      = zoneFps.filter((f) => f.tier !== "architectural" && w.near(f));
      const doorSpan       = zoneFps.filter((f) => f.tier === "architectural" && w.near(f))
                               .reduce((s, d) => s + w.span(d), 0);
      const objSpan        = furniture.reduce((s, f) => s + w.span(f), 0);
      const rawRemaining   = w.wallLen - objSpan - doorSpan;
      const isTouchingWall = rawRemaining < 0.15;
      const remaining      = isTouchingWall ? 0.0 : rawRemaining;
      const atCapacity     = remaining < 0.3;

      return {
        wall: w.name,
        remaining: +remaining.toFixed(3),
        atCapacity,
        isTouchingWall,
        label: isTouchingWall
          ? `${w.name} wall: furniture flush (≤ 15 cm gap clamped to 0)`
          : atCapacity
          ? `${w.name} wall at capacity (${fmtM(remaining)} remaining)`
          : `${w.name} wall — ${fmtM(remaining)} available`,
      };
    });
}

// ── Main zone-map builder ──

/**
 * Builds the ZoneMap from a set of (optionally healed) footprints.
 *
 * Algorithm:
 *  1. Cluster primary-tier footprints by centroid proximity ≤ 2 m (semantic).
 *  2. Assign all non-primary footprints to the nearest cluster centroid.
 *  3. Run Geometric Aperture Scan on cluster AABBs to find Transition Portals
 *     (gaps in the 0.8–1.2 m range with perpendicular overlap).
 *  4. Classify each zone (bedroom / kitchen / living / hallway / unclassified)
 *     from its member object names and AABB aspect ratio.
 *  5. Compute zone-local wall clearances (adjacent walls only).
 */
function buildZoneMap(fps: Footprint[], rd: RoomDimensions | null): ZoneMap {
  const primary = fps.filter((f) => f.tier === "primary");

  if (primary.length === 0) return { zones: [], transitionPortals: [] };

  // Step 1 — cluster primary objects, then attempt Object-Aware Fused-Zone splitting
  const rawClusters   = clusterByProximity(primary, deriveClusterRadius(rd));
  const clusters      = splitFusedClusters(rawClusters);

  // Stable ordering: sort clusters by their top-left corner (zMin then xMin)
  clusters.sort((a, b) => {
    const az = Math.min(...a.map((f) => f.zMin));
    const bz = Math.min(...b.map((f) => f.zMin));
    if (Math.abs(az - bz) > 0.1) return az - bz;
    return Math.min(...a.map((f) => f.xMin)) - Math.min(...b.map((f) => f.xMin));
  });

  // Emit Cluster Density Map diagnostic (after splitting, reflects final layout)
  logClusterDensityMap(clusters);

  // Preliminary zone stubs (needed for assignment + portal detection)
  const stubs = clusters.map((members, idx) => ({
    id:      `zone-${String.fromCharCode(97 + idx)}`, // zone-a, zone-b, …
    bounds:  boundsOf(members),
    members,
  }));

  // Step 2 — assign all footprints to nearest zone
  const uidToZoneId = new Map<string, string>();
  for (const { id, members } of stubs) {
    for (const fp of members) uidToZoneId.set(fp.uid, id);
  }
  for (const fp of fps) {
    if (!uidToZoneId.has(fp.uid)) {
      const zid = nearestZoneId(fp, stubs);
      if (zid) uidToZoneId.set(fp.uid, zid);
    }
  }

  // Step 3 — Geometric Aperture Scan → Transition Portals
  const transitionPortals = detectTransitionPortals(stubs);
  const portalZoneIds     = new Set(transitionPortals.flatMap((p) => p.between));

  // Step 4 & 5 — build final Zone objects
  const zones: Zone[] = stubs.map(({ id, bounds, members }, idx) => {
    const allInZone = fps.filter((f) => uidToZoneId.get(f.uid) === id);
    const names     = allInZone.map((f) => f.name);

    const w           = bounds.xMax - bounds.xMin;
    const d           = bounds.zMax - bounds.zMin;
    const aspect      = Math.max(w, d) / Math.max(Math.min(w, d), 0.01);
    const isHallway   = aspect > HALLWAY_ASPECT_RATIO || portalZoneIds.has(id);
    const areaSqm     = +((bounds.xMax - bounds.xMin) * (bounds.zMax - bounds.zMin)).toFixed(2);

    // ── Raw AABB diagnostic log ───────────────────────────────────────────────
    console.log(
      `[ZoneEngine] Zone ${id} raw AABB — ` +
      `xMin=${bounds.xMin.toFixed(2)} xMax=${bounds.xMax.toFixed(2)} ` +
      `zMin=${bounds.zMin.toFixed(2)} zMax=${bounds.zMax.toFixed(2)} ` +
      `(${members.length} primary object${members.length !== 1 ? "s" : ""}, area=${areaSqm}m²)`,
    );

    // ── Anchor-based zone classification (priority over pattern matching) ──────
    // Identify kitchen architectural anchors present in this zone.
    const kitchenAnchorNames = names.filter(
      (n) => KITCHEN_ANCHOR_RE.test(n) && matchesArchitecturalAnchor(n),
    );
    const hasAnyAnchor = names.some((n) => matchesArchitecturalAnchor(n));

    let type: ZoneType;
    if (!isHallway && kitchenAnchorNames.length > 0) {
      type = "kitchen";
      // Build a de-duplicated, title-cased anchor list for the log message.
      const anchorList = [...new Set(kitchenAnchorNames.map((n) => {
        const match = STANDARD_ANCHORS.find((a) => a.isArchitecturalAnchor && a.pattern.test(n));
        // Use the first word of the name as the canonical anchor label.
        return n.split(/\s+/)[0]!.charAt(0).toUpperCase() + n.split(/\s+/)[0]!.slice(1).toLowerCase();
      }))].join("/");
      console.log(
        `[ZoneEngine] Kitchen identified via ${anchorList} cluster. Area: ${areaSqm}m².`,
      );
    } else if (!isHallway && !hasAnyAnchor && areaSqm > 10) {
      // Large empty area (> 10 m²) with no fixed fixtures → Living/Bedroom Area.
      type = "living_bedroom";
      console.log(
        `[ZoneEngine] Living/Bedroom Area identified (${areaSqm}m², no fixtures).`,
      );
    } else {
      type = getZoneType(names, isHallway);
    }

    const label          = getZoneLabel(type, idx);
    const wallClearances = rd ? computeZoneWallClearances(allInZone, bounds, rd) : [];

    // ── Negative Space — Unobstructed Floor Area ─────────────────────────────
    const fixtureFootprintM2 = allInZone
      .filter((f) => f.tier === "primary")
      .reduce((sum, f) => sum + f.width * f.depth, 0);
    const unobstructedFloorAreaM2 = +Math.max(0, areaSqm - fixtureFootprintM2).toFixed(2);

    // ── Kitchen Width (cabinet-to-opposite-wall) ──────────────────────────────
    const kitchenWidthM = (type === "kitchen" && rd)
      ? computeKitchenWidth(allInZone, rd)
      : undefined;

    return {
      id,
      label,
      type,
      objectUids:              allInZone.map((f) => f.uid),
      areaSqm,
      bounds,
      isTransitionPortal:      portalZoneIds.has(id) || undefined,
      wallClearances,
      unobstructedFloorAreaM2,
      kitchenWidthM,
      // Calibration fields — populated later in buildSpatialDigest
      verifiedWidthM:    null,
      verifiedLengthM:   null,
      isDimensionLocked: false,
    };
  });

  return { zones, transitionPortals };
}

// ─── Zone Defragmentation — merge same-label zones within 2 m ────────────────

/**
 * Post-pass over the zone list produced by buildZoneMap.
 * If two zones share the same label AND their centroids are within 2 m of each
 * other they are treated as scan fragments of the same physical room and merged
 * into a single zone with a union AABB.
 *
 * Logs: [Merge] Combined N X segments into 1 Corridor.
 */
function defragmentZones(zones: Zone[]): Zone[] {
  const MERGE_DIST = 2.0; // metres — max centroid separation to trigger merge
  const merged: Zone[] = [];
  const absorbed = new Set<string>();

  for (let i = 0; i < zones.length; i++) {
    if (absorbed.has(zones[i].id)) continue;
    const base     = zones[i];
    const siblings: Zone[] = [base];

    for (let j = i + 1; j < zones.length; j++) {
      if (absorbed.has(zones[j].id)) continue;
      const other = zones[j];
      if (other.label !== base.label) continue;

      const bx = (base.bounds.xMin  + base.bounds.xMax)  / 2;
      const bz = (base.bounds.zMin  + base.bounds.zMax)  / 2;
      const ox = (other.bounds.xMin + other.bounds.xMax) / 2;
      const oz = (other.bounds.zMin + other.bounds.zMax) / 2;
      const dist = Math.sqrt((bx - ox) ** 2 + (bz - oz) ** 2);

      if (dist <= MERGE_DIST) {
        siblings.push(other);
        absorbed.add(other.id);
      }
    }

    if (siblings.length === 1) {
      merged.push(base);
    } else {
      const xMin     = Math.min(...siblings.map((z) => z.bounds.xMin));
      const xMax     = Math.max(...siblings.map((z) => z.bounds.xMax));
      const zMin     = Math.min(...siblings.map((z) => z.bounds.zMin));
      const zMax     = Math.max(...siblings.map((z) => z.bounds.zMax));
      const allUids  = Array.from(new Set(siblings.flatMap((z) => z.objectUids)));
      const areaSqm  = +((xMax - xMin) * (zMax - zMin)).toFixed(2);

      console.log(
        `[Merge] Combined ${siblings.length} ${base.label} segments into 1 Corridor.`
      );

      merged.push({
        ...base,
        bounds:            { xMin, xMax, zMin, zMax },
        objectUids:        allUids,
        areaSqm,
        isDimensionLocked: siblings.some((z) => z.isDimensionLocked),
      });
    }
  }

  return merged;
}

// ─── Diagnostic Report — per-object spatial summary ──────────────────────────

/**
 * Prints a formatted table to the console:
 *   Object Name | Raw Pos (x, z) | Zone | Distance to Nearest Wall
 *
 * "Distance to nearest wall" is the minimum of the four clearances from the
 * object's bounding box to the closest room wall.  A negative value means the
 * object is partially outside the room boundary (scan artifact).
 */
function logDiagnosticReport(
  fps:     Footprint[],
  zoneMap: ZoneMap,
  rd:      RoomDimensions | null,
): void {
  const halfW = rd ? rd.width  / 2 : 0;
  const halfL = rd ? rd.length / 2 : 0;

  const uidToZone = new Map<string, Zone>();
  for (const z of zoneMap.zones) {
    for (const uid of z.objectUids) uidToZone.set(uid, z);
  }

  const WALL_COL  = 20;
  const NAME_COL  = 28;
  const POS_COL   = 21;
  const ZONE_COL  = 16;

  console.log("[ZoneEngine] ── Spatial Diagnostic Report ──────────────────────────────");
  console.log(
    `  ${"Object Name".padEnd(NAME_COL)} | ${"Raw Pos (x,z)".padEnd(POS_COL)} | ${"Zone".padEnd(ZONE_COL)} | Nearest Wall`,
  );
  console.log(
    `  ${"─".repeat(NAME_COL)} | ${"─".repeat(POS_COL)} | ${"─".repeat(ZONE_COL)} | ${"─".repeat(WALL_COL)}`,
  );

  for (const fp of fps) {
    const zone      = uidToZone.get(fp.uid);
    const zoneName  = zone?.label ?? "—";
    let nearestWall = "—";

    if (rd) {
      const walls = [
        { name: "north", dist: fp.zMin + halfL },
        { name: "south", dist: halfL - fp.zMax },
        { name: "east",  dist: halfW - fp.xMax },
        { name: "west",  dist: fp.xMin + halfW },
      ];
      const best  = walls.reduce((a, b) => a.dist < b.dist ? a : b);
      nearestWall = `${best.name} (${best.dist.toFixed(2)} m)`;
    }

    const nameCol = fp.name.slice(0, NAME_COL).padEnd(NAME_COL);
    const posCol  = `(${fp.cx.toFixed(2)}, ${fp.cz.toFixed(2)})`.padEnd(POS_COL).slice(0, POS_COL);
    const zoneCol = zoneName.slice(0, ZONE_COL).padEnd(ZONE_COL);
    console.log(`  ${nameCol} | ${posCol} | ${zoneCol} | ${nearestWall}`);
  }
}

// ─── Zone Calibration — digest-only local scale correction ───────────────────

/**
 * Applies per-zone tape-measure overrides to footprints (digest-only).
 *
 * For each zone that has a calibration entry:
 *  1. Compute local scale factors: fx = verifiedWidthM / zone.bounds width,
 *                                  fz = verifiedLengthM / zone.bounds length.
 *  2. Rescale every footprint that belongs to that zone — both its dimensions
 *     (width, depth) and its centroid / AABB edges — proportionally around the
 *     zone's centre of mass.
 *
 * Returns a new footprint array. The store's detectedObjects is never touched.
 */
function applyZoneCalibrations(
  fps:          Footprint[],
  zones:        Zone[],
  calibrations: ZoneCalibrationMap,
): Footprint[] {
  if (Object.keys(calibrations).length === 0) return fps;

  // Build a mutable copy so we can patch individual entries.
  const result = fps.slice();

  for (const zone of zones) {
    const cal = calibrations[zone.label];
    if (!cal) continue;

    const scannedW = zone.bounds.xMax - zone.bounds.xMin;
    const scannedL = zone.bounds.zMax - zone.bounds.zMin;
    const fx = (cal.widthM  != null && scannedW > 0) ? cal.widthM  / scannedW : 1.0;
    const fz = (cal.lengthM != null && scannedL > 0) ? cal.lengthM / scannedL : 1.0;

    if (Math.abs(fx - 1) < 0.001 && Math.abs(fz - 1) < 0.001) continue; // no correction needed

    const cx = (zone.bounds.xMin + zone.bounds.xMax) / 2;
    const cz = (zone.bounds.zMin + zone.bounds.zMax) / 2;
    const zoneUidSet = new Set(zone.objectUids);

    let corrected = 0;
    for (let i = 0; i < result.length; i++) {
      const fp = result[i];
      if (!zoneUidSet.has(fp.uid)) continue;

      const newCx   = cx + (fp.cx - cx) * fx;
      const newCz   = cz + (fp.cz - cz) * fz;
      const newHalfW = (fp.width * fx) / 2;
      const newHalfD = (fp.depth * fz) / 2;

      result[i] = {
        ...fp,
        cx:    newCx,
        cz:    newCz,
        width: +(fp.width * fx).toFixed(3),
        depth: +(fp.depth * fz).toFixed(3),
        xMin:  newCx - newHalfW,
        xMax:  newCx + newHalfW,
        zMin:  newCz - newHalfD,
        zMax:  newCz + newHalfD,
      };
      corrected++;
    }

    console.log(
      `[RoomEngine] ${zone.label} manually calibrated to ` +
      `${cal.widthM?.toFixed(1) ?? "?"}m x ${cal.lengthM?.toFixed(1) ?? "?"}m. ` +
      `Adjusting ${corrected} objects to local grid.`,
    );
  }

  return result;
}

// ─── Inverse Square Vision Scaling ───────────────────────────────────────────

/**
 * Inverse Square Vision Scaling — perspective depth correction for distant zones.
 *
 * Standard raycasting places objects using the 3D intersection of the camera ray
 * with scene geometry, so depth is already encoded in position3D[2].  However,
 * the depth (Z) *dimension* of objects in far zones is foreshortened by the
 * perspective projection: a 2 m deep cabinet seen from across an open-plan space
 * appears shallower in the image than the same cabinet nearby.
 *
 * This function corrects for that foreshortening.  For each secondary zone whose
 * centre is farther from the origin than the anchor zone, we apply a
 * square-root depth correction:
 *
 *   correctionFactor = √(zoneDepth / anchorDepth)
 *
 * The √ damping is empirical — full linear perspective correction overshoots in
 * typical wide-angle interior captures (≈ 70–90° horizontal FoV).  The square-
 * root midpoint gives realistic depths while avoiding over-expansion of the far
 * zone footprints.
 *
 * Only zones MORE THAN 5 % deeper than the anchor and no more than 8× deeper
 * receive a correction (very deep zones are likely outdoors or separate rooms
 * where a different anchor should apply).
 */
function applyInverseSquareDepthScaling(
  fps:      Footprint[],
  zones:    Zone[],
  anchorId: string,
): Footprint[] {
  const anchor = zones.find((z) => z.id === anchorId);
  if (!anchor || zones.length < 2) return fps;

  // Use the absolute midpoint of the anchor zone's Z extent as the reference depth.
  const anchorZCenter = Math.abs((anchor.bounds.zMin + anchor.bounds.zMax) / 2);
  if (anchorZCenter < 0.01) return fps; // degenerate — skip

  const result = fps.slice();

  for (const zone of zones) {
    if (zone.id === anchorId) continue;
    const zCenter = Math.abs((zone.bounds.zMin + zone.bounds.zMax) / 2);
    if (zCenter < 0.01) continue;

    const depthRatio = zCenter / anchorZCenter;
    // Only correct zones meaningfully deeper than the anchor (> 5 %, ≤ 8×)
    if (depthRatio <= 1.05 || depthRatio > 8.0) continue;

    // Square-root damped correction — models indoor wide-angle foreshortening
    const cf = Math.sqrt(depthRatio);
    const zoneUidSet = new Set(zone.objectUids);
    let corrected = 0;

    for (let i = 0; i < result.length; i++) {
      const fp = result[i];
      if (!zoneUidSet.has(fp.uid)) continue;
      const newDepth = +(fp.depth * cf).toFixed(3);
      result[i] = {
        ...fp,
        depth: newDepth,
        zMin:  fp.cz - newDepth / 2,
        zMax:  fp.cz + newDepth / 2,
      };
      corrected++;
    }

    if (corrected > 0) {
      console.log(
        `[InvSqDepth] Zone "${zone.label}" — ` +
        `zCenter=${zCenter.toFixed(2)} m vs anchor=${anchorZCenter.toFixed(2)} m, ` +
        `depthRatio=${depthRatio.toFixed(3)}, cf=${cf.toFixed(3)}. ` +
        `${corrected} footprint(s) depth-corrected.`,
      );
    }
  }

  return result;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function buildSpatialDigest(
  objects:          DetectedObject[],
  roomDimensions:   RoomDimensions | null,
  zoneCalibrations: ZoneCalibrationMap = {},
  isPreCalibrated:  boolean = false,
): SpatialDigest {
  // ── Coordinate-Agnostic Validation Engine ──────────────────────────────────
  // Skipped entirely when isPreCalibrated — the Gemini-anchored scan already
  // produces real-world dimensions; running the healer would re-introduce
  // the scale error we just bypassed.
  const validationResult = isPreCalibrated
    ? {
        objects:           objects,
        trials:            [] as import("@/utils/semanticScale").PlausibilityTrial[],
        ghostArtifactUids: [] as string[],
        globalScore:       100,
      }
    : runValidationLoop(objects, undefined, undefined, roomDimensions);
  const {
    objects:           validatedObjects,
    trials:            validationTrials,
    ghostArtifactUids: ghostUids,
    globalScore,
  } = validationResult;
  const spatialHealthReport = isPreCalibrated
    ? undefined
    : generateSpatialHealthReport(validationResult);

  const ghostSet = new Set(ghostUids);

  const rawFps = toFootprints(validatedObjects);

  // ── Structural Healing (digest-only) ────────────────────────────────────
  // Snap bed + platform centroid drift before any geometric computation so
  // that gap, clearance, and path-blockage results are physically coherent.
  // The store objects are NEVER mutated here.
  const { fps: allFps, healedUids } = snapStackedObjects(rawFps);

  // Ghost Artifacts are excluded from gap/clearance footprints.
  // Their footprints still participate in zone clustering (position is valid)
  // but must not contribute to clearance maths.
  const fps = allFps.filter((fp) => !ghostSet.has(fp.uid));

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

  // Inventory — use validatedObjects so labels reflect corrected dimensions.
  const inventory = computeInventory(validatedObjects);

  // Map uid → inventory index so we can annotate in O(n)
  const uidToIdx = new Map(validatedObjects.map((o, i) => [o.uid, i]));

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
  // Annotate Ghost Artifacts so the AI knows these dimensions are unreliable.
  for (const uid of ghostUids) {
    const idx = uidToIdx.get(uid);
    if (idx != null) {
      inventory[idx] = {
        ...inventory[idx],
        label: inventory[idx].label + ` | [Scan Artifact — dimensions excluded]`,
      };
    }
  }

  // ── Hybrid Zoning (uses allFps so Ghost Artifact positions contribute) ─────
  const _zoneMapBase = buildZoneMap(allFps, roomDimensions);
  const zoneMapRaw   = { ..._zoneMapBase, zones: defragmentZones(_zoneMapBase.zones) };

  // ── Zone Calibration — apply digest-only local corrections ────────────────
  // Corrections are applied AFTER zone assignment so we know which objects
  // belong to each zone, but BEFORE gap/clearance/inventory maths so those
  // calculations use the corrected geometry.
  const calibratedFps = applyZoneCalibrations(
    fps,
    zoneMapRaw.zones,
    zoneCalibrations,
  );
  // If any calibration was active, also re-apply to allFps so wall-clearance
  // maths for zone-local walls reflect the corrected positions.
  const calibratedAllFps = applyZoneCalibrations(
    allFps,
    zoneMapRaw.zones,
    zoneCalibrations,
  );

  // Inject calibration metadata into Zone objects, and recompute zone-local
  // wall clearances from the calibrated footprint set when a calibration is active.
  const hasAnyCalibration = Object.keys(zoneCalibrations).length > 0;
  const zoneMap: typeof zoneMapRaw = {
    ...zoneMapRaw,
    zones: zoneMapRaw.zones.map((z) => {
      const cal = zoneCalibrations[z.label];
      const wallClearances = (hasAnyCalibration && roomDimensions)
        ? computeZoneWallClearances(
            calibratedAllFps.filter((f) => z.objectUids.includes(f.uid)),
            z.bounds,
            roomDimensions,
          )
        : z.wallClearances;
      return {
        ...z,
        wallClearances,
        verifiedWidthM:    cal?.widthM  ?? null,
        verifiedLengthM:   cal?.lengthM ?? null,
        isDimensionLocked: cal != null && (cal.widthM != null || cal.lengthM != null),
      };
    }),
  };

  // Inject zoneId into every inventory entry so the AI can reference zones.
  const uidToZone = new Map<string, string>();
  for (const z of zoneMap.zones) {
    for (const uid of z.objectUids) uidToZone.set(uid, z.id);
  }
  for (let i = 0; i < validatedObjects.length; i++) {
    const zid = uidToZone.get(validatedObjects[i].uid);
    if (zid) {
      const zoneName = zoneMap.zones.find((z) => z.id === zid)?.label ?? zid;
      inventory[i] = {
        ...inventory[i],
        zoneId: zid,
        label: inventory[i].label + ` | zone: ${zoneName}`,
      };
    }
  }

  // ── Inverse Square Vision Scaling — depth correction for far zones ───────
  // The anchor zone is zone-a (first cluster, typically the room the user
  // calibrated in).  Skipped when pre-calibrated — real-world dimensions
  // were already used by Gemini and the correction would double-apply.
  const anchorZoneId = zoneMap.zones[0]?.id ?? "";
  const perspectiveFps = (!isPreCalibrated && anchorZoneId)
    ? applyInverseSquareDepthScaling(calibratedFps, zoneMap.zones, anchorZoneId)
    : calibratedFps;

  // ── Diagnostic Report — full per-object spatial table ────────────────────
  logDiagnosticReport(perspectiveFps, zoneMap, roomDimensions);

  return {
    inventory,
    objectGaps:              computeObjectGaps(perspectiveFps),
    wallClearances:          roomDimensions ? computeWallClearances(perspectiveFps, roomDimensions) : [],
    pathBlockages:           computePathBlockages(perspectiveFps),
    healedUids:              healedUids.length > 0 ? healedUids : undefined,
    zoneMap,
    validationTrials:        validationTrials.length > 0 ? validationTrials : undefined,
    ghostArtifactUids:       ghostUids.length > 0 ? ghostUids : undefined,
    globalPlausibilityScore: globalScore,
    spatialHealthReport,
    isPreCalibrated,
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
