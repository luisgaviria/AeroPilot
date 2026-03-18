import { DetectedObject } from "@/types/auto-discovery";
import { StandardAnchor, STANDARD_ANCHORS, TIER_WEIGHTS, BED_LADDER, SOFA_STANDARD_LENGTH } from "@/data/standardAnchors";
import type { RoomDimensions } from "@/utils/spatial";

/** One matched object contributing to the global scale calibration. */
export interface AnchorMatch {
  uid:             string;
  objectName:      string;
  tier:            StandardAnchor["tier"];
  dimension:       "height" | "width";
  measuredValue:   number;
  standardValue:   number;
  /** standard / measured — the scale correction this anchor suggests. */
  suggestedFactor: number;
  /** False when rejected by the outlier filter. */
  included:        boolean;
  /** Class reliability weight (1.0 High / 0.4 Medium / 0.1 Low). */
  classWeight:     number;
  /** Gemini detection confidence at time of scan. */
  detectionConf:   number;
  /** classWeight × detectionConf — the final vote strength logged to console. */
  finalWeight:     number;
  /**
   * True when flagged as an Architectural Artifact — an oversized opening excluded
   * from the global scale calculation.  classWeight is reduced to 0.01 and
   * `included` is forced false.  The object is still reported in the anchor log
   * so the UI can surface it as a warning.
   */
  isArchitecturalArtifact?: boolean;
  /**
   * Max raw depth (Three.js world units) found across all vertically-stacked
   * Bed/Bench/Platform members.  Set when a stack member is deeper than the
   * bed's own rawDimensions.depth — the store uses this to override the
   * scaled depth so a square mesh doesn't produce a square footprint.
   */
  stackMaxRawDepth?: number;
  /** True when this bed was detected within NOOK_WALL_PROXIMITY of ≥2 wall planes. */
  nookConstrained?: boolean;
  /**
   * How the depth dimension is treated for this bed match.
   * "ladder"        — freestanding; both axes subjected to standard ladder consensus.
   * "custom-builtin" — nook/built-in; Width = Reliable Scale Anchor, Depth = mesh-faithful.
   * "freestanding"  — no walls and no supporting platform detected.
   */
  depthMode?: "ladder" | "custom-builtin" | "freestanding";
}

export interface ScaleResult {
  /** Weighted-average scale factor (1.0 when no anchors are available). */
  factor:  number;
  /** Per-anchor match log, including outliers, for diagnostics/UI. */
  matches: AnchorMatch[];
  /**
   * uid → raw depth override (Three.js world units).
   * Populated by the Structural Stack Merge pass when a vertically-adjacent
   * Bed/Bench/Platform member has a deeper raw footprint than the bed itself.
   * The store should apply these AFTER normal scaling:
   *   finalDepth = rawDepthOverrides.get(uid) × globalScale.z
   */
  rawDepthOverrides: Map<string, number>;
}

/**
 * Minimum Gemini confidence for an object to participate in calibration.
 * Below this threshold the label is too uncertain to be a reliable reference.
 */
const ANCHOR_CONFIDENCE_MIN = 0.88;

/**
 * Maximum fractional deviation from the weighted median before a factor is
 * classified as an outlier and excluded from the weighted average.
 */
const OUTLIER_TOLERANCE = 0.25;

/**
 * Architectural plausibility bounds for ceiling height (metres).
 * If the candidate scale puts the mesh ceiling outside this range the Reality
 * Filter triggers and High-Weight anchors (classWeight ≥ 1.0) are used alone.
 */
const CEILING_MIN_M = 2.1;
/** Extended to 7.0 m to accommodate loft / double-height spaces. */
const CEILING_MAX_M = 7.0;
/** Ceiling height (metres) above which a space is treated as loft/double-height.
 *  In loft mode the Furniture Ladder (bed) is trusted MORE than architectural averages. */
const LOFT_THRESHOLD_M = 3.5;
/** Multiplier applied to bed anchor finalWeights when loft mode is active. */
const LOFT_BED_BOOST = 1.5;
/** Max fractional deviation between bed and sofa implied factors for a consensus lock. */
const CONSENSUS_TOLERANCE = 0.10;

// ── Sanity Floor constants ─────────────────────────────────────────────────────
/** Absolute minimum acceptable ceiling height (metres). Below this the scale
 *  is physically implausible and must be overridden. */
const MIN_CEILING_HEIGHT = 2.3;

// ── Architectural Anomaly Filter constants ────────────────────────────────────
/** Object-name patterns subject to the Anomaly Filter. */
const ARCH_ANOMALY_RE = /\bsliding\s+door\b|\bwindow\b|\bdoor(?:way)?\b|\bentry\b/i;
/** Maximum plausible real-world width (metres) for an opening.
 *  Wider objects likely grabbed adjacent wall geometry — "14 m sliding door" hallucination. */
const ARCH_WIDTH_MAX_M = 3.5;
/** Maximum plausible real-world height (metres) for an opening. */
const ARCH_HEIGHT_MAX_M = 3.0;
/** classWeight floor applied to an Architectural Artifact.
 *  Near-zero (not exactly zero) so the anchor still appears in the log. */
const ARCH_ARTIFACT_WEIGHT = 0.01;

// ── Loft-Height Normalization ─────────────────────────────────────────────────
/** Relaxed outlier-rejection tolerance for loft / double-height spaces.
 *  In tall rooms furniture scale can diverge further from the median while
 *  remaining physically plausible — the tighter OUTLIER_TOLERANCE would starve
 *  the engine of anchor votes. */
const LOFT_OUTLIER_TOLERANCE = 0.40;

// ── Nook / Co-planar constants ────────────────────────────────────────────────
/** Within this distance (metres) of a wall plane → the bed is wall-constrained. */
const NOOK_WALL_PROXIMITY = 0.05;
/** Vertical search radius (metres) for co-planar base detection.
 *  If another object's top face is within this distance below the bed's floor, it
 *  is treated as a supporting platform (platform bed, storage base, etc.). */
const PLATFORM_DETECTION_RADIUS = 0.2;
/** Minimum fraction of the bed's footprint area that must overlap a candidate base. */
const PLATFORM_OVERLAP_MIN = 0.30;

// ── Nook-constraint helpers ───────────────────────────────────────────────────

interface NookResult {
  constrained: boolean;
  walls: Array<"N" | "S" | "E" | "W">;
}

/**
 * Returns which room walls (if any) the object's bounding box is within
 * NOOK_WALL_PROXIMITY of, using the same N/S/E/W convention as SpatialDigest.
 * A bed is "nook-constrained" when it touches ≥ 2 walls.
 */
function detectNookConstraint(obj: DetectedObject, rd: RoomDimensions): NookResult {
  const raw = obj.rawDimensions;
  if (!raw) return { constrained: false, walls: [] };

  const [x, , z] = obj.position3D;
  const hw = rd.width  / 2;
  const hl = rd.length / 2;

  const xMin = x - raw.width / 2;
  const xMax = x + raw.width / 2;
  const zMin = z - raw.depth  / 2;
  const zMax = z + raw.depth  / 2;

  const walls: Array<"N" | "S" | "E" | "W"> = [];
  if (zMin <= -hl + NOOK_WALL_PROXIMITY) walls.push("N");
  if (zMax >=  hl - NOOK_WALL_PROXIMITY) walls.push("S");
  if (xMax >=  hw - NOOK_WALL_PROXIMITY) walls.push("E");
  if (xMin <= -hw + NOOK_WALL_PROXIMITY) walls.push("W");

  return { constrained: walls.length >= 2, walls };
}

/**
 * Returns the first detected object that appears to be a supporting platform
 * directly under `bed` — i.e. any non-bed object whose:
 *   • top face Y is within PLATFORM_DETECTION_RADIUS of the bed's floor Y, AND
 *   • footprint overlaps ≥ PLATFORM_OVERLAP_MIN of the bed's footprint area.
 *
 * Used for Co-planar Growth: a platform-bed storage base or bench signals that
 * the observed depth encompasses the entire base, not just the mattress.
 */
function detectSupportingPlatform(
  bed:        DetectedObject,
  candidates: DetectedObject[],
): DetectedObject | undefined {
  const raw = bed.rawDimensions;
  if (!raw) return undefined;

  const [bx, by, bz] = bed.position3D;
  const bedFloorY    = by - raw.height / 2;

  return candidates.find((obj) => {
    if (obj.uid === bed.uid)                   return false;
    if (/\bbed\b/i.test(obj.name))             return false;
    if (!obj.rawDimensions || !obj.position3D) return false;

    const [ox, oy, oz] = obj.position3D;
    const platformTopY = oy + obj.rawDimensions.height / 2;
    if (Math.abs(platformTopY - bedFloorY) > PLATFORM_DETECTION_RADIUS) return false;

    // Footprint overlap check
    const bxMin = bx - raw.width / 2;  const bxMax = bx + raw.width / 2;
    const bzMin = bz - raw.depth / 2;  const bzMax = bz + raw.depth / 2;
    const oxMin = ox - obj.rawDimensions.width / 2;
    const oxMax = ox + obj.rawDimensions.width / 2;
    const ozMin = oz - obj.rawDimensions.depth / 2;
    const ozMax = oz + obj.rawDimensions.depth / 2;

    const xOverlap   = Math.max(0, Math.min(bxMax, oxMax) - Math.max(bxMin, oxMin));
    const zOverlap   = Math.max(0, Math.min(bzMax, ozMax) - Math.max(bzMin, ozMin));
    const overlapArea = xOverlap * zOverlap;
    const bedArea     = raw.width * raw.depth;
    return bedArea > 0 && overlapArea / bedArea >= PLATFORM_OVERLAP_MIN;
  });
}

/**
 * Returns every candidate that matches ASSEMBLY_RE (Bed/Bench/Platform),
 * is vertically adjacent to `bed` (bounding-box gap ≤ `vGap` metres), AND
 * overlaps its X-Z footprint.
 *
 * Used for Structural Stack Merge: the max raw depth across all returned
 * members (plus the bed itself) becomes the depth that is scaled, ensuring
 * a deeper platform base drives the final rectangular footprint rather than
 * the mattress-only mesh.
 */
const STACK_ASSEMBLY_RE = /\bbed\b|\bbench\b|\bplatform\b/i;

function detectStackMembers(
  bed:        DetectedObject,
  candidates: DetectedObject[],
  vGap        = PLATFORM_DETECTION_RADIUS,
): DetectedObject[] {
  const raw = bed.rawDimensions;
  if (!raw) return [];

  const [bx, by, bz] = bed.position3D;
  const bedYMin = by - raw.height / 2;
  const bedYMax = by + raw.height / 2;
  const bxMin   = bx - raw.width  / 2;
  const bxMax   = bx + raw.width  / 2;
  const bzMin   = bz - raw.depth  / 2;
  const bzMax   = bz + raw.depth  / 2;

  return candidates.filter((obj) => {
    if (obj.uid === bed.uid)                   return false;
    if (!STACK_ASSEMBLY_RE.test(obj.name))     return false;
    if (!obj.rawDimensions || !obj.position3D) return false;

    const [ox, oy, oz] = obj.position3D;
    const r = obj.rawDimensions;

    // Vertical gap between bounding boxes (negative = overlapping / touching)
    const vertGap = Math.max(bedYMin, oy - r.height / 2) - Math.min(bedYMax, oy + r.height / 2);
    if (vertGap > vGap) return false;

    // X-Z footprint must overlap
    const oxMin = ox - r.width / 2, oxMax = ox + r.width / 2;
    const ozMin = oz - r.depth / 2, ozMax = oz + r.depth / 2;
    return bxMin < oxMax && bxMax > oxMin && bzMin < ozMax && bzMax > ozMin;
  });
}

/** Weighted average of suggestedFactor across a set of matches. */
function weightedAvg(ms: AnchorMatch[]): number {
  let wSum = 0, wTotal = 0;
  for (const m of ms) { wSum += m.suggestedFactor * m.finalWeight; wTotal += m.finalWeight; }
  return wTotal > 0 ? +(wSum / wTotal).toFixed(4) : 1.0;
}

/**
 * Compute a global scale factor from detected objects matched against the
 * Standard Reference Library using a Weighted Heuristic approach.
 *
 * Algorithm
 * ─────────
 *  1. Match each high-confidence object against STANDARD_ANCHORS (first match wins).
 *  2. Compute suggestedFactor = standard / measured.
 *  3. Compute the weighted median (weighted by finalWeight = classWeight × detectionConf).
 *  4. Reject outliers: factors deviating > OUTLIER_TOLERANCE from the weighted median.
 *  5. Compute the weighted average of surviving factors.
 *  6. Reality Filter (Gaussian Clamp): if `factor × ceilingMeshHeight` falls outside
 *     [CEILING_MIN_M, CEILING_MAX_M], trigger a Heuristic Variance warning and
 *     re-compute using only High-Weight anchors (classWeight ≥ 1.0).
 *  7. Log the Weighted Confidence Score for every anchor.
 *
 * classWeight breakdown (from StandardAnchor.classWeight):
 *   1.0 — High:   Bed, Sofa, Dining Table (predictable sizes, strong votes)
 *   0.4 — Medium: Chair, Desk, Toilet, Counter (somewhat standardised)
 *   0.1 — Low:    Doorway, Window, Archway (highly variable; cannot outvote a bed)
 *
 * @param objects          Detected objects from the current scan.
 * @param anchors          Reference library (defaults to STANDARD_ANCHORS).
 * @param ceilingMeshHeight Raw mesh ceiling height in Three.js units — used by
 *                          the Reality Filter to validate plausibility.
 */
export function computeScaleFactor(
  objects:            DetectedObject[],
  anchors:            StandardAnchor[] = STANDARD_ANCHORS,
  ceilingMeshHeight?: number,
  roomDimensions?:    RoomDimensions,
): ScaleResult {
  const candidates = objects.filter(
    (o) => (o.confidence ?? 0) >= ANCHOR_CONFIDENCE_MIN && o.rawDimensions,
  );

  const matches: AnchorMatch[] = [];
  const rawDepthOverrides = new Map<string, number>();

  // ── Pass 1: Match every object (beds use Queen default; ladder runs in Pass 2) ─
  for (const obj of candidates) {
    for (const anchor of anchors) {
      if (!anchor.pattern.test(obj.name)) continue;
      const measured = obj.rawDimensions![anchor.dimension];
      if (!measured || measured <= 0) break; // degenerate measurement
      const detectionConf = +(obj.confidence ?? 0).toFixed(4);
      const classWeight   = anchor.classWeight;
      const finalWeight   = +(classWeight * detectionConf).toFixed(4);
      matches.push({
        uid:             obj.uid,
        objectName:      obj.name,
        tier:            anchor.tier,
        dimension:       anchor.dimension,
        measuredValue:   +measured.toFixed(4),
        standardValue:   anchor.standard,
        suggestedFactor: +(anchor.standard / measured).toFixed(4),
        included:        true,
        classWeight,
        detectionConf,
        finalWeight,
      });
      break; // one anchor per object — first match wins
    }
  }

  if (matches.length === 0) return { factor: 1.0, matches, rawDepthOverrides };

  // ── Pass 2: Bed Ladder — Nearest-Neighbour Heuristic ─────────────────────────
  // Compute a preliminary consensus from non-bed anchors, then pick the BED_LADDER
  // rung whose implied factor is closest to that consensus (least room-wide
  // scale deviation). Falls back to nearest-to-1.0 if no other anchors exist.
  //
  // Wall-Constraint Heuristic (Req 2 & 3):
  //   If the bed is within NOOK_WALL_PROXIMITY of ≥2 walls → nook-constrained.
  //   Width = Reliable Scale Anchor (ladder applies). Depth = Custom/Built-in (mesh-faithful).
  //
  // Co-planar Growth (Req 1 & 4):
  //   If a supporting platform is within PLATFORM_DETECTION_RADIUS below the bed,
  //   log it for spatialDigest.ts to apply the base-mass footprint depth.
  //   If neither constraint exists → freestanding → standard 4-way ladder (Req 4).
  const isBedMatch = (m: AnchorMatch) => /\bbed\b/i.test(m.objectName);
  const nonBedMatches = matches.filter((m) => !isBedMatch(m));
  const prelimFactor = nonBedMatches.length > 0
    ? weightedAvg(nonBedMatches)
    : 1.0;

  let chosenBedLabel: string | undefined;
  for (const m of matches) {
    if (!isBedMatch(m)) continue;

    // Look up the full DetectedObject so we can check spatial context
    const bedObj = candidates.find((o) => o.uid === m.uid);

    const nook = (bedObj && roomDimensions)
      ? detectNookConstraint(bedObj, roomDimensions)
      : { constrained: false, walls: [] as Array<"N" | "S" | "E" | "W"> };

    const platform = bedObj
      ? detectSupportingPlatform(bedObj, candidates)
      : undefined;

    const isFreestanding = !nook.constrained && !platform;

    // Pick the nearest-neighbour BED_LADDER rung regardless of constraint mode —
    // Width is always the reliable axis; the rung selection is the same.
    let bestSize = BED_LADDER[0];
    let bestDiff = Infinity;
    for (const size of BED_LADDER) {
      const impliedFactor = size.width / m.measuredValue;
      const diff = Math.abs(impliedFactor - prelimFactor);
      if (diff < bestDiff) { bestDiff = diff; bestSize = size; }
    }
    chosenBedLabel    = bestSize.label;
    m.standardValue   = bestSize.width;
    m.suggestedFactor = +(bestSize.width / m.measuredValue).toFixed(4);
    m.nookConstrained = nook.constrained;
    m.depthMode       = nook.constrained ? "custom-builtin" : isFreestanding ? "freestanding" : "ladder";

    // ── Structural Stack Merge ────────────────────────────────────────────────
    // Find all Bed/Bench/Platform objects vertically adjacent to this bed and
    // overlapping its X-Z footprint.  Use the MAX raw depth across the whole
    // stack as the authoritative depth for final scaling.
    //
    // Why: a bed mesh is often scanned as a near-square (raw width ≈ raw depth),
    // but the true physical footprint is defined by the deepest stack member
    // (e.g. a built-in bed platform at 2.2 m raw vs mattress at 2.0 m raw).
    // Applying the scale factor to the platform's raw depth yields the correct
    // rectangular dimension (≈ 2.1–2.2 m) instead of a forced square.
    if (bedObj) {
      const stackMembers = detectStackMembers(bedObj, candidates);
      const bedRawDepth  = bedObj.rawDimensions!.depth;
      const maxRawDepth  = stackMembers.reduce(
        (max, obj) => Math.max(max, obj.rawDimensions!.depth),
        bedRawDepth,
      );
      if (maxRawDepth > bedRawDepth) {
        m.stackMaxRawDepth = maxRawDepth;
        rawDepthOverrides.set(m.uid, maxRawDepth);
        console.log(
          `[SemanticScale] Structural Stack Merge: "${m.objectName}" ` +
          `raw depth ${bedRawDepth.toFixed(3)} m → ${maxRawDepth.toFixed(3)} m ` +
          `(max across stack [${stackMembers.map((s) => s.name).join(", ")}]). ` +
          `Scaled depth ≈ ${(maxRawDepth * m.suggestedFactor).toFixed(3)} m.`,
        );
      }
    }

    if (nook.constrained) {
      console.log(
        `[SemanticScale] Heuristic matched "Bed" to ${bestSize.label}-size standard ` +
        `(${bestSize.width}m) based on proportional consensus. ` +
        `Wall-Constraint detected (walls: ${nook.walls.join(", ")}) — ` +
        `Width=${m.suggestedFactor.toFixed(4)}× [Reliable Scale Anchor] | Depth=Custom/Built-in.`,
      );
    } else if (platform) {
      console.log(
        `[SemanticScale] Heuristic matched "Bed" to ${bestSize.label}-size standard ` +
        `(${bestSize.width}m) based on proportional consensus. ` +
        `Co-planar base detected ("${platform.name}") — Depth will use base footprint in SpatialDigest.`,
      );
    } else {
      // Req 4 — freestanding default: standard 4-way ladder consensus
      console.log(
        `[SemanticScale] Heuristic matched "Bed" to ${bestSize.label}-size standard ` +
        `(${bestSize.width}m) based on proportional consensus. ` +
        `(Freestanding — standard 4-way ladder. raw=${m.measuredValue.toFixed(3)}m, ` +
        `impliedFactor=${m.suggestedFactor.toFixed(4)}×, prelimConsensus=${prelimFactor.toFixed(4)}×)`,
      );
    }
  }

  // ── Pass 3: Architectural Anomaly Filter ──────────────────────────────────
  // Estimate real-world dimensions of architectural elements using high-confidence
  // furniture anchors only (classWeight ≥ 0.4, beds included post-ladder).
  // Any Sliding Door / Window / Doorway that would be wider than ARCH_WIDTH_MAX_M
  // or taller than ARCH_HEIGHT_MAX_M is an Architectural Artifact: it almost
  // certainly grabbed adjacent wall or ceiling geometry. Flag it, reduce its
  // classWeight to 0.01, and force-exclude it from the scale calculation so it
  // cannot produce hallucinated 14 m dimensions.
  {
    const furniturePrelim = (() => {
      const fm = matches.filter((m) => m.classWeight >= 0.4);
      return fm.length > 0 ? weightedAvg(fm) : 1.0;
    })();

    for (const m of matches) {
      if (!ARCH_ANOMALY_RE.test(m.objectName)) continue;
      if (m.isArchitecturalArtifact) continue; // idempotent
      const obj = candidates.find((o) => o.uid === m.uid);
      if (!obj?.rawDimensions) continue;

      const estWidth  = obj.rawDimensions.width  * furniturePrelim;
      const estHeight = obj.rawDimensions.height * furniturePrelim;

      if (estWidth > ARCH_WIDTH_MAX_M || estHeight > ARCH_HEIGHT_MAX_M) {
        m.classWeight             = ARCH_ARTIFACT_WEIGHT;
        m.finalWeight             = +(ARCH_ARTIFACT_WEIGHT * m.detectionConf).toFixed(4);
        m.included                = false;
        m.isArchitecturalArtifact = true;
        console.warn(
          `[SemanticScale] ⚠ Architectural Artifact: "${m.objectName}" estimated at ` +
          `${estWidth.toFixed(2)} m wide × ${estHeight.toFixed(2)} m tall ` +
          `(furniture prelim=${furniturePrelim.toFixed(4)}×) — ` +
          `exceeds plausibility bounds [w>${ARCH_WIDTH_MAX_M} m or h>${ARCH_HEIGHT_MAX_M} m]. ` +
          `classWeight → ${ARCH_ARTIFACT_WEIGHT}, excluded from scale calculation.`,
        );
      }
    }
  }

  // ── Weighted Confidence Score log ─────────────────────────────────────────
  console.log(
    `[SemanticScale] Weighted Confidence Scores (${matches.length} anchors matched):`,
  );
  for (const m of matches) {
    console.log(
      `  ${m.objectName.padEnd(20)} factor=${m.suggestedFactor.toFixed(4)}×` +
      `  classW=${m.classWeight.toFixed(1)}  conf=${m.detectionConf.toFixed(3)}` +
      `  finalW=${m.finalWeight.toFixed(4)}` +
      `  [${m.tier}]`,
    );
  }

  // ── Weighted median for outlier baseline ──────────────────────────────────
  // Sort by suggestedFactor; accumulate weight until we pass 50 % of total.
  const totalFinalWeight = matches.reduce((s, m) => s + m.finalWeight, 0);
  const sorted = [...matches].sort((a, b) => a.suggestedFactor - b.suggestedFactor);
  let cumWeight = 0;
  let weightedMedian = sorted[0].suggestedFactor;
  for (const m of sorted) {
    cumWeight += m.finalWeight;
    if (cumWeight >= totalFinalWeight / 2) { weightedMedian = m.suggestedFactor; break; }
  }

  for (const m of matches) {
    const deviation = Math.abs(m.suggestedFactor - weightedMedian) / weightedMedian;
    m.included = deviation <= OUTLIER_TOLERANCE;
    if (!m.included) {
      console.log(
        `[SemanticScale] Outlier rejected: "${m.objectName}" ` +
        `factor=${m.suggestedFactor.toFixed(3)}× (weightedMedian=${weightedMedian.toFixed(3)}×, ` +
        `deviation=${(deviation * 100).toFixed(1)}% > ${OUTLIER_TOLERANCE * 100}%)`,
      );
    }
  }

  const survivors = matches.filter((m) => m.included);
  if (survivors.length === 0) {
    console.warn("[SemanticScale] All matches rejected as outliers — using 1.0");
    return { factor: 1.0, matches, rawDepthOverrides };
  }

  // ── Weighted average of surviving factors ─────────────────────────────────
  let factor = weightedAvg(survivors);

  console.log(
    `[SemanticScale] Initial factor=${factor}× from ${survivors.length}/${matches.length} anchors: ` +
    survivors.map((m) =>
      `${m.objectName}(${m.suggestedFactor.toFixed(3)}× w=${m.finalWeight.toFixed(3)})`
    ).join(", "),
  );

  // ── Loft Awareness + Loft-Height Normalization ───────────────────────────
  // If the tentative scale yields a ceiling above LOFT_THRESHOLD_M the space is
  // double-height or a loft.
  //   • Boost Furniture Ladder (bed) weights so floor objects dominate calibration.
  //   • Re-run the outlier filter at LOFT_OUTLIER_TOLERANCE — in a tall space,
  //     furniture factors can spread further from the median without being
  //     physically implausible.  Architectural Artifacts are never re-instated.
  //   • Standard Ladder rungs remain the primary anchor for the final factor.
  if (ceilingMeshHeight && ceilingMeshHeight > 0) {
    const tentativeCeiling = factor * ceilingMeshHeight;
    if (tentativeCeiling > LOFT_THRESHOLD_M) {
      const bedSurvivors = survivors.filter((m) => isBedMatch(m));
      if (bedSurvivors.length > 0) {
        // Boost bed anchor weights
        for (const m of bedSurvivors) {
          m.finalWeight = +(m.finalWeight * LOFT_BED_BOOST).toFixed(4);
        }

        // Loft-Height Normalization: re-run outlier rejection with relaxed tolerance
        // using the same weightedMedian pivot computed before the first outlier pass.
        // Artifacts (classWeight = ARCH_ARTIFACT_WEIGHT) are never re-instated.
        for (const m of matches) {
          if (m.isArchitecturalArtifact) continue;
          const deviation = Math.abs(m.suggestedFactor - weightedMedian) / weightedMedian;
          m.included = deviation <= LOFT_OUTLIER_TOLERANCE;
        }
        const loftSurvivors = matches.filter((m) => m.included);
        const loftFactor    = loftSurvivors.length > 0 ? weightedAvg(loftSurvivors) : factor;
        console.log(
          `[SemanticScale] Loft detected (tentative ceiling=${tentativeCeiling.toFixed(2)}m > ` +
          `${LOFT_THRESHOLD_M}m): Furniture Ladder ×${LOFT_BED_BOOST}, ` +
          `outlier tolerance → ${LOFT_OUTLIER_TOLERANCE * 100}% ` +
          `(${loftSurvivors.length} anchors retained). ` +
          `factor=${factor.toFixed(4)}× → ${loftFactor.toFixed(4)}×.`,
        );
        factor = loftFactor;
      }
    }
  }

  // ── Reality Filter (Gaussian Clamp) ───────────────────────────────────────
  // If this scale maps the mesh ceiling outside human architectural norms,
  // it means low-weight objects (windows, doors) are distorting the result.
  // Re-compute using only High-Weight anchors (classWeight ≥ 1.0) if available.
  if (ceilingMeshHeight && ceilingMeshHeight > 0) {
    const scaledCeiling = +(factor * ceilingMeshHeight).toFixed(3);
    if (scaledCeiling < CEILING_MIN_M || scaledCeiling > CEILING_MAX_M) {
      const highAnchors = survivors.filter((m) => m.classWeight >= 1.0);
      if (highAnchors.length > 0) {
        const hFactor  = weightedAvg(highAnchors);
        const hCeiling = +(hFactor * ceilingMeshHeight).toFixed(3);
        console.warn(
          `[SemanticScale] ⚠ Heuristic Variance: factor=${factor}× → ceiling=${scaledCeiling}m ` +
          `is outside [${CEILING_MIN_M}–${CEILING_MAX_M}m]. ` +
          `Upweighting ${highAnchors.length} High anchor(s) → factor=${hFactor}× ` +
          `(ceiling=${hCeiling}m). Low/Medium anchors overruled.`,
        );
        factor = hFactor;
      } else {
        console.warn(
          `[SemanticScale] ⚠ Heuristic Variance: factor=${factor}× → ceiling=${scaledCeiling}m ` +
          `is outside [${CEILING_MIN_M}–${CEILING_MAX_M}m]. ` +
          `No High-Weight anchors available — keeping factor=${factor}×.`,
        );
      }
    } else {
      console.log(
        `[SemanticScale] Reality Filter passed: ceiling=${scaledCeiling}m ` +
        `∈ [${CEILING_MIN_M}–${CEILING_MAX_M}m] ✓`,
      );
    }
  }

  // ── Consensus Validation ──────────────────────────────────────────────────
  // If the Bed matched Queen AND a Sofa's raw width × factor ≈ SOFA_STANDARD_LENGTH,
  // both furniture anchors agree — lock the scale and log the consensus.
  if (chosenBedLabel === "Queen") {
    const sofaMatch = survivors.find((m) => /\bsofa\b|\bcouch\b|\bsectional\b/i.test(m.objectName));
    if (sofaMatch) {
      const sofaObj  = candidates.find((o) => o.uid === sofaMatch.uid);
      const sofaRawWidth = sofaObj?.rawDimensions?.width ?? 0;
      if (sofaRawWidth > 0) {
        const sofaScaledLength = sofaRawWidth * factor;
        const sofaDeviation    = Math.abs(sofaScaledLength - SOFA_STANDARD_LENGTH) / SOFA_STANDARD_LENGTH;
        if (sofaDeviation <= CONSENSUS_TOLERANCE) {
          console.log(
            `[SemanticScale] ✓ Consensus lock: Bed=Queen (1.5m) + Sofa length=` +
            `${sofaScaledLength.toFixed(2)}m ≈ ${SOFA_STANDARD_LENGTH}m ` +
            `(deviation=${(sofaDeviation * 100).toFixed(1)}%). Scale factor locked at ${factor}×.`,
          );
        } else {
          console.log(
            `[SemanticScale] Consensus check: Bed=Queen but Sofa scaled length=` +
            `${sofaScaledLength.toFixed(2)}m (expected ≈${SOFA_STANDARD_LENGTH}m, ` +
            `deviation=${(sofaDeviation * 100).toFixed(1)}% > ${CONSENSUS_TOLERANCE * 100}%) — no lock.`,
          );
        }
      }
    }
  }

  // ── Sanity Floor Reality Check ────────────────────────────────────────────
  // If the resulting ceiling height is below the architectural minimum, the
  // scale is still too small. Boost using Override Factor A (ceiling target)
  // and/or Override Factor B (ladder-selected bed width), taking the larger.
  if (ceilingMeshHeight && ceilingMeshHeight > 0) {
    const resultingCeiling = +(factor * ceilingMeshHeight).toFixed(3);
    if (resultingCeiling < MIN_CEILING_HEIGHT) {
      console.warn(
        `[SemanticScale] ⚠ Reality Check Triggered: Resulting ceiling is only ${resultingCeiling}m ` +
        `(minimum is ${MIN_CEILING_HEIGHT}m).`,
      );

      // Override Factor A — push ceiling to 2.4 m (comfortable residential target)
      const factorA = +(2.4 / ceilingMeshHeight).toFixed(4);

      // Override Factor B — use the ladder-selected bed suggestedFactor if a Bed was matched
      const bedMatch = matches.find((m) => isBedMatch(m) && m.measuredValue > 0);
      let newFactor = factorA;

      if (bedMatch) {
        // bedMatch.suggestedFactor already encodes the nearest-neighbour ladder selection
        const factorB = bedMatch.suggestedFactor;
        console.log(
          `[SemanticScale] Override Factor A (ceiling)=${factorA}× | ` +
          `Override Factor B (${chosenBedLabel ?? "Bed"} width)=${factorB}×`,
        );
        newFactor = Math.max(factorA, factorB);
      } else {
        console.log(
          `[SemanticScale] Override Factor A (ceiling)=${factorA}× | ` +
          `Override Factor B — no Bed detected, using Factor A only`,
        );
      }

      console.warn(
        `[SemanticScale] Boosting scale to ${newFactor}× to meet architectural minimums.`,
      );
      factor = newFactor;
    }
  } else if (!ceilingMeshHeight) {
    // No ceiling geometry and no bed → cannot verify physical plausibility
    const bedMatch = matches.find((m) => /\bbed\b/i.test(m.objectName) && m.measuredValue > 0);
    if (!bedMatch) {
      console.warn(
        `[SemanticScale] ⚠ Reality cannot be verified: no ceilingMeshHeight provided ` +
        `and no Bed anchor detected. Keeping factor=${factor}×.`,
      );
    }
  }

  return { factor, matches, rawDepthOverrides };
}

/**
 * Apply a scale factor to a raw-dimension object.
 * Returns a new dimensions object; never mutates the input.
 *
 * Aspect Ratio Fidelity (Req 1): the SAME `factor` is applied to width, depth,
 * and height — width and depth are NEVER forced equal.  For bed-ladder
 * calibration the formula is:
 *   factor = Ladder_Standard_Width / Raw_Mesh_Width
 * which preserves the original mesh proportions across all three axes.
 */
export function scaleDims(
  raw:    { width: number; height: number; depth: number },
  factor: number,
): { width: number; height: number; depth: number } {
  return {
    width:  +(raw.width  * factor).toFixed(3),
    height: +(raw.height * factor).toFixed(3),
    depth:  +(raw.depth  * factor).toFixed(3),
  };
}

// ── Hybrid Validation ─────────────────────────────────────────────────────────

/** Compact feet-and-inches string for conflict messages (avoids cross-util import). */
function toFtIn(m: number): string {
  const totalIn = m / 0.0254;
  const ft      = Math.floor(totalIn / 12);
  const inc     = Math.round(totalIn % 12);
  return inc === 12 ? `${ft + 1}'0"` : `${ft}'${inc}"`;
}

/**
 * Hybrid Validation pass — run AFTER geometric scaling (reapplyScale).
 *
 * For every non-opening, non-user-verified object that has a rawMeshDimensions
 * baseline and a matching entry in STANDARD_ANCHORS:
 *
 *  1. Compute "semantic dims" via the anchor's own per-object factor
 *     (anchor.standard / rawMesh[anchor.dimension]), applied uniformly.
 *  2. Compare geometric size on the anchor axis to the semantic standard:
 *     • Deviation ≤ 15 % → HIGH CONFIDENCE: final dims = 70 % geometric + 30 % semantic.
 *     • Deviation  > 15 % → SCALE CONFLICT: keep geometric size, write conflict message.
 *
 * Objects with no matching anchor, openings, or user-verified objects pass through unchanged.
 */
export function applyHybridValidation(
  objects: DetectedObject[],
  anchors: StandardAnchor[] = STANDARD_ANCHORS,
): DetectedObject[] {
  return objects.map((obj) => {
    if (obj.isOpening || obj.isUserVerified)            return obj;
    if (!obj.rawMeshDimensions || !obj.dimensions)      return obj;

    const anchor = anchors.find((a) => a.pattern.test(obj.name));
    if (!anchor) return obj;

    const geomSize     = anchor.dimension === "width" ? obj.dimensions.width : obj.dimensions.height;
    const semanticSize = anchor.standard;
    const deviation    = Math.abs(geomSize - semanticSize) / semanticSize;

    if (deviation > 0.15) {
      const conflictMsg = `Geometric ${toFtIn(geomSize)} vs standard ${toFtIn(semanticSize)}`;
      console.log(
        `[HybridValidation] ⚠ Scale conflict "${obj.name}": ` +
        `${conflictMsg} (${(deviation * 100).toFixed(0)}% deviation)`
      );
      return { ...obj, scaleValidation: "scale-conflict" as const, scaleConflictMsg: conflictMsg };
    }

    // High confidence — blend 70 % geometric + 30 % semantic.
    const rawRef         = anchor.dimension === "width" ? obj.rawMeshDimensions.width : obj.rawMeshDimensions.height;
    const semanticFactor = rawRef > 0 ? semanticSize / rawRef : 1;
    const semanticDims   = scaleDims(obj.rawMeshDimensions, semanticFactor);

    const blended = {
      width:  +(0.7 * obj.dimensions.width  + 0.3 * semanticDims.width ).toFixed(3),
      height: +(0.7 * obj.dimensions.height + 0.3 * semanticDims.height).toFixed(3),
      depth:  +(0.7 * obj.dimensions.depth  + 0.3 * semanticDims.depth ).toFixed(3),
    };

    return { ...obj, dimensions: blended, scaleValidation: "high-confidence" as const, scaleConflictMsg: undefined };
  });
}

// ─────────────────────────────────────────────────────────────────────────────

/** Per-axis scale vector — replaces the scalar scaleFactor in the Source-of-Truth refactor. */
export interface ScaleVector3 { x: number; y: number; z: number; }

/**
 * Apply a per-axis scale vector to a raw-dimension object.
 *  width  → scale.x  (room-width  / East-West axis)
 *  height → scale.y  (vertical    / ceiling axis)
 *  depth  → scale.z  (room-length / North-South axis)
 *
 * Returns a new dimensions object; never mutates the input.
 */
export function applyScaleVector(
  raw:   { width: number; height: number; depth: number },
  scale: ScaleVector3,
): { width: number; height: number; depth: number } {
  return {
    width:  +(raw.width  * scale.x).toFixed(3),
    height: +(raw.height * scale.y).toFixed(3),
    depth:  +(raw.depth  * scale.z).toFixed(3),
  };
}

/**
 * Applies Structural Stack Merge depth overrides to already-scaled objects.
 *
 * Call this AFTER `reapplyScale` / `reapplyAndValidate`.  For every bed whose
 * `computeScaleFactor` result recorded a `rawDepthOverrides` entry, the depth
 * dimension is replaced with:
 *
 *   finalDepth = rawDepthOverride × gs.z
 *
 * This implements Req 1 (Stack Merge) + Req 2 (Uniform Scaling): the MAX raw
 * depth from the entire Bed/Bench/Platform stack is scaled by the same global
 * Z factor that was applied to every other dimension, preserving a true
 * rectangular footprint instead of a forced square.
 *
 * Objects with no override entry are returned unchanged.
 */
export function applyRawDepthOverrides(
  objects:   DetectedObject[],
  overrides: Map<string, number>,
  gs:        ScaleVector3,
): DetectedObject[] {
  if (overrides.size === 0) return objects;
  return objects.map((o) => {
    const rawDepth = overrides.get(o.uid);
    if (rawDepth == null || !o.dimensions) return o;
    const scaledDepth = +(rawDepth * gs.z).toFixed(3);
    console.log(
      `[SemanticScale] Stack depth override applied to "${o.name}": ` +
      `${o.dimensions.depth} m → ${scaledDepth} m ` +
      `(raw stack max=${rawDepth.toFixed(3)} m × gs.z=${gs.z.toFixed(4)}×).`,
    );
    return { ...o, dimensions: { ...o.dimensions, depth: scaledDepth } };
  });
}
