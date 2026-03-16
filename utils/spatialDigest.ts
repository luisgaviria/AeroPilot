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

// ─── Inventory — every object, regardless of tier ─────────────────────────────

/**
 * Builds the full room inventory so the AI "sees" every detected object.
 * Objects without a measured footprint are still listed as pending.
 */
function computeInventory(objects: DetectedObject[]): ObjectInventoryEntry[] {
  return objects.map((o) => {
    const tier    = classifyTier(o.name);
    const hasDims = !!o.dimensions;
    const w = o.dimensions?.width;
    const h = o.dimensions?.height;
    const d = o.dimensions?.depth;

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
    const remaining  = w.wallLen - objSpan - doorSpan;
    const atCapacity = remaining < 0.3;

    return {
      wall:      w.name,
      remaining: +remaining.toFixed(3),
      atCapacity,
      label: atCapacity
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
  const fps = toFootprints(objects);
  return {
    inventory:      computeInventory(objects),
    objectGaps:     computeObjectGaps(fps),
    wallClearances: roomDimensions ? computeWallClearances(fps, roomDimensions) : [],
    pathBlockages:  computePathBlockages(fps),
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
