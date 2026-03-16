import { DetectedObject } from "@/types/auto-discovery";
import { StandardAnchor, STANDARD_ANCHORS, TIER_WEIGHTS, BED_LADDER, SOFA_STANDARD_LENGTH } from "@/data/standardAnchors";

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
}

export interface ScaleResult {
  /** Weighted-average scale factor (1.0 when no anchors are available). */
  factor:  number;
  /** Per-anchor match log, including outliers, for diagnostics/UI. */
  matches: AnchorMatch[];
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
): ScaleResult {
  const candidates = objects.filter(
    (o) => (o.confidence ?? 0) >= ANCHOR_CONFIDENCE_MIN && o.rawDimensions,
  );

  const matches: AnchorMatch[] = [];

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

  if (matches.length === 0) return { factor: 1.0, matches };

  // ── Pass 2: Bed Ladder — Nearest-Neighbour Heuristic ─────────────────────────
  // Compute a preliminary consensus from non-bed anchors, then pick the BED_LADDER
  // rung whose implied factor is closest to that consensus (least room-wide
  // scale deviation). Falls back to nearest-to-1.0 if no other anchors exist.
  const isBedMatch = (m: AnchorMatch) => /\bbed\b/i.test(m.objectName);
  const nonBedMatches = matches.filter((m) => !isBedMatch(m));
  const prelimFactor = nonBedMatches.length > 0
    ? weightedAvg(nonBedMatches)
    : 1.0;

  let chosenBedLabel: string | undefined;
  for (const m of matches) {
    if (!isBedMatch(m)) continue;
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
    console.log(
      `[SemanticScale] Heuristic matched "Bed" to ${bestSize.label}-size standard ` +
      `(${bestSize.width}m) based on proportional consensus. ` +
      `(raw=${m.measuredValue.toFixed(3)}m, impliedFactor=${m.suggestedFactor.toFixed(4)}×, ` +
      `prelimConsensus=${prelimFactor.toFixed(4)}×)`,
    );
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
    return { factor: 1.0, matches };
  }

  // ── Weighted average of surviving factors ─────────────────────────────────
  let factor = weightedAvg(survivors);

  console.log(
    `[SemanticScale] Initial factor=${factor}× from ${survivors.length}/${matches.length} anchors: ` +
    survivors.map((m) =>
      `${m.objectName}(${m.suggestedFactor.toFixed(3)}× w=${m.finalWeight.toFixed(3)})`
    ).join(", "),
  );

  // ── Loft Awareness ────────────────────────────────────────────────────────
  // If the tentative scale yields a ceiling above LOFT_THRESHOLD_M, the space
  // is double-height or a loft. Architectural averages are unreliable in these
  // spaces, so boost Furniture Ladder (bed) anchor weights and recompute.
  if (ceilingMeshHeight && ceilingMeshHeight > 0) {
    const tentativeCeiling = factor * ceilingMeshHeight;
    if (tentativeCeiling > LOFT_THRESHOLD_M) {
      const bedSurvivors = survivors.filter((m) => isBedMatch(m));
      if (bedSurvivors.length > 0) {
        for (const m of bedSurvivors) {
          m.finalWeight = +(m.finalWeight * LOFT_BED_BOOST).toFixed(4);
        }
        const loftFactor = weightedAvg(survivors);
        console.log(
          `[SemanticScale] Loft detected (tentative ceiling=${tentativeCeiling.toFixed(2)}m > ` +
          `${LOFT_THRESHOLD_M}m): Furniture Ladder weight boosted ×${LOFT_BED_BOOST} → ` +
          `factor=${factor}× → ${loftFactor}×.`,
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

  return { factor, matches };
}

/**
 * Apply a scale factor to a raw-dimension object.
 * Returns a new dimensions object; never mutates the input.
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
