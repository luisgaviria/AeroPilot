/**
 * Standard Reference Library — Semantic Anchor sizes.
 *
 * Every entry maps a label pattern to a known real-world dimension so the
 * engine can compute a global scale-correction factor purely from geometry
 * (no hardcoded object lists at call-sites).
 *
 * Tier:
 *   'architectural' — code-regulated, structural, highly reliable (weight ×3)
 *   'fixture'       — installed at standard heights/sizes, reliable    (weight ×2)
 *   'furniture'     — variable by design, lower trust                  (weight ×1)
 *
 * `dimension` is the axis of the DetectedObject's `rawDimensions` that is
 * compared against `standard` to derive the scale factor.
 */
export interface StandardAnchor {
  pattern:   RegExp;
  dimension: "height" | "width";
  /** Known real-world value in metres. */
  standard:  number;
  tier:      "architectural" | "fixture" | "furniture";
}

export const STANDARD_ANCHORS: StandardAnchor[] = [
  // ── Architectural ── (strongest scale calibrators) ──────────────────────────
  { pattern: /\bdoor(?:way)?\b|\bentry\b/i,                     dimension: "height", standard: 2.03, tier: "architectural" },
  { pattern: /\bcounter(?:top)?\b|\bkitchen\s+counter\b/i,      dimension: "height", standard: 0.91, tier: "architectural" },
  { pattern: /\barchway\b|\barch\b/i,                           dimension: "height", standard: 2.10, tier: "architectural" },
  { pattern: /\bwindow\b/i,                                     dimension: "height", standard: 1.37, tier: "architectural" },
  { pattern: /\bstair\b|\bstep\b/i,                             dimension: "height", standard: 0.18, tier: "architectural" },
  { pattern: /\bkitchen\s+island\b/i,                           dimension: "height", standard: 0.91, tier: "architectural" },

  // ── Fixtures ────────────────────────────────────────────────────────────────
  { pattern: /\bbathr?o?o?m?\s*sink\b|\bbasin\b|\bpedestal\s+sink\b/i, dimension: "height", standard: 0.86, tier: "fixture" },
  { pattern: /\btoilet\b|\bwc\b/i,                              dimension: "height", standard: 0.40, tier: "fixture" },
  { pattern: /\bbath\s*tub\b|\btub\b/i,                         dimension: "height", standard: 0.58, tier: "fixture" },
  { pattern: /\blight\s*switch\b|\bwall\s*switch\b/i,           dimension: "height", standard: 0.08, tier: "fixture" },
  { pattern: /\boutlet\b|\bsocket\b|\bpower\s+point\b/i,        dimension: "height", standard: 0.06, tier: "fixture" },

  // ── Furniture ── (variable — lower trust) ───────────────────────────────────
  { pattern: /\bdining\s+table\b/i,                             dimension: "height", standard: 0.76, tier: "furniture" },
  { pattern: /\bdesk\b|\bwriting\s+table\b/i,                   dimension: "height", standard: 0.76, tier: "furniture" },
  { pattern: /\bcoffee\s+table\b|\bcenter\s+table\b|\bcentre\s+table\b/i, dimension: "height", standard: 0.42, tier: "furniture" },
  { pattern: /\bend\s+table\b|\bnightstand\b|\bnight\s*stand\b/i,         dimension: "height", standard: 0.60, tier: "furniture" },
  { pattern: /\bsofa\b|\bcouch\b|\bsectional\b/i,               dimension: "height", standard: 0.86, tier: "furniture" },
  { pattern: /\bbed\b/i,                                        dimension: "height", standard: 0.55, tier: "furniture" },
  { pattern: /\bwardrobe\b|\barmoire\b|\bcloset\b/i,             dimension: "height", standard: 2.10, tier: "furniture" },
  { pattern: /\bbookshelf\b|\bbookcase\b/i,                     dimension: "height", standard: 1.80, tier: "furniture" },
  { pattern: /\bdresser\b|\bchest\s+of\s+drawers\b/i,           dimension: "height", standard: 1.20, tier: "furniture" },
];

/** Tier weights for the confidence-weighted average. */
export const TIER_WEIGHTS: Record<StandardAnchor["tier"], number> = {
  architectural: 3,
  fixture:       2,
  furniture:     1,
};
