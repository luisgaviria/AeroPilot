import { DetectedObject } from "@/types/auto-discovery";
import { StandardAnchor, STANDARD_ANCHORS, TIER_WEIGHTS } from "@/data/standardAnchors";

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
 * Maximum fractional deviation from the median before a factor is classified
 * as an outlier and excluded from the weighted average.
 *
 * 0.25 = 25 % tolerance — rejects custom/non-standard furniture while keeping
 * the architectural anchors that all agree on the true room scale.
 *
 * Example: door=0.82×, counter=0.80×, coffee_table=0.50× (custom height)
 *   median=0.80, tolerance window=[0.60, 1.00]
 *   coffee_table (0.50) is OUTSIDE → rejected; door+counter are averaged.
 */
const OUTLIER_TOLERANCE = 0.25;

/**
 * Compute a global scale factor from detected objects matched against the
 * Standard Reference Library.
 *
 * Steps:
 *  1. Match each high-confidence object with known dimensions against STANDARD_ANCHORS.
 *     Only the first matching anchor is used per object.
 *  2. Compute suggestedFactor = standard / measured for each match.
 *  3. Compute the median factor across all matches.
 *  4. Reject outliers: factors that deviate > OUTLIER_TOLERANCE from the median.
 *  5. Return the tier-weighted average of the surviving factors.
 *     Architectural anchors (doors, counters) are weighted 3×; furniture 1×.
 */
export function computeScaleFactor(
  objects: DetectedObject[],
  anchors: StandardAnchor[] = STANDARD_ANCHORS,
): ScaleResult {
  const candidates = objects.filter(
    (o) => (o.confidence ?? 0) >= ANCHOR_CONFIDENCE_MIN && o.rawDimensions,
  );

  const matches: AnchorMatch[] = [];

  for (const obj of candidates) {
    for (const anchor of anchors) {
      if (!anchor.pattern.test(obj.name)) continue;
      const measured = obj.rawDimensions![anchor.dimension];
      if (!measured || measured <= 0) break; // degenerate measurement
      matches.push({
        uid:             obj.uid,
        objectName:      obj.name,
        tier:            anchor.tier,
        dimension:       anchor.dimension,
        measuredValue:   +measured.toFixed(4),
        standardValue:   anchor.standard,
        suggestedFactor: +(anchor.standard / measured).toFixed(4),
        included:        true,
      });
      break; // one anchor per object — first match wins
    }
  }

  if (matches.length === 0) return { factor: 1.0, matches };

  // ── Outlier rejection via median absolute deviation ────────────────────────
  const sorted  = [...matches].sort((a, b) => a.suggestedFactor - b.suggestedFactor);
  const midIdx  = Math.floor(sorted.length / 2);
  // Prefer the lower of the two central values for an even-length array — this
  // biases toward architectural anchors which tend to be slightly under 1.0 in
  // scaled-down models.
  const median  = sorted[midIdx].suggestedFactor;

  for (const m of matches) {
    const deviation = Math.abs(m.suggestedFactor - median) / median;
    m.included = deviation <= OUTLIER_TOLERANCE;
    if (!m.included) {
      console.log(
        `[SemanticScale] Outlier rejected: "${m.objectName}" ` +
        `factor=${m.suggestedFactor.toFixed(3)} (median=${median.toFixed(3)}, ` +
        `deviation=${(deviation * 100).toFixed(1)} % > ${OUTLIER_TOLERANCE * 100} %)`
      );
    }
  }

  const survivors = matches.filter((m) => m.included);
  if (survivors.length === 0) {
    console.warn("[SemanticScale] All matches rejected as outliers — using 1.0");
    return { factor: 1.0, matches };
  }

  // ── Tier-weighted average ──────────────────────────────────────────────────
  let weightedSum = 0;
  let totalWeight = 0;
  for (const m of survivors) {
    const w = TIER_WEIGHTS[m.tier];
    weightedSum += m.suggestedFactor * w;
    totalWeight += w;
  }

  const factor = +(weightedSum / totalWeight).toFixed(4);

  console.log(
    `[SemanticScale] Factor=${factor} from ${survivors.length}/${matches.length} anchors: ` +
    survivors.map((m) => `${m.objectName}(${m.suggestedFactor.toFixed(3)}×)`).join(", ")
  );

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
