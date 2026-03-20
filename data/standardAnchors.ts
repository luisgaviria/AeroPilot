/**
 * Standard Reference Library — Semantic Anchor sizes.
 *
 * Every entry maps a label pattern to a known real-world dimension so the
 * engine can compute a global scale-correction factor purely from geometry
 * (no hardcoded object lists at call-sites).
 *
 * Tier (structural role — used by HybridValidation, NOT by scale weighting):
 *   'architectural' — code-regulated, structural
 *   'fixture'       — installed at standard heights/sizes
 *   'furniture'     — variable by design
 *
 * classWeight (reliability for scale calibration — used by computeScaleFactor):
 *   1.0 — High:   Bed, Sofa, Dining Table. Predictable sizes; rarely custom.
 *                 These objects anchor the scale most strongly.
 *   0.4 — Medium: Chair, Desk, Toilet, Bathtub, Counter, Wardrobe, Stair.
 *                 Somewhat standardised but with meaningful size variation.
 *   0.1 — Low:    Doorway, Window, Archway, Curtain, Pillow, small fixtures.
 *                 Highly variable apparent dimensions; easily distorted by
 *                 depth / viewing angle. A misidentified '9 m doorway'
 *                 at classWeight 0.1 cannot outvote a '2 m bed' at 1.0.
 *
 * `dimension` is the axis of DetectedObject.rawDimensions compared against
 * `standard` to derive the per-anchor scale factor.
 */

/** One rung of the Bed Ladder — a plausible standard mattress width. */
export interface BedSize {
  label: "Twin" | "Full" | "Queen" | "King";
  /** Standard width in metres. */
  width: number;
}

/**
 * Bed Ladder — all plausible standard mattress widths in ascending order.
 * `computeScaleFactor` uses a nearest-neighbour heuristic to pick the rung
 * that best agrees with the preliminary consensus from other anchors.
 */
export const BED_LADDER: BedSize[] = [
  { label: "Twin",  width: 0.90 },
  { label: "Full",  width: 1.35 },
  { label: "Queen", width: 1.50 },
  { label: "King",  width: 1.95 },
];

/**
 * Standard sofa/couch length (width axis) in metres.
 * Used by the Consensus Validation step in `computeScaleFactor`:
 * if the Bed ladder matches Queen AND the sofa scales to this length, the
 * factor is considered consensus-locked.
 */
export const SOFA_STANDARD_LENGTH = 2.1;

export interface StandardAnchor {
  pattern:     RegExp;
  dimension:   "height" | "width";
  /** Known real-world value in metres. */
  standard:    number;
  tier:        "architectural" | "fixture" | "furniture";
  /**
   * Reliability weight for the weighted confidence average in computeScaleFactor.
   * 1.0 = High, 0.4 = Medium, 0.1 = Low.
   */
  classWeight: number;
  /**
   * Maximum credible width (metres) for this object type.
   * If a detected object's width exceeds this value it likely grabbed adjacent
   * geometry — the Sanity Guard triggers a targeted Voxel Isolation re-run.
   * Not set for object types where width is genuinely unbounded (e.g. long counters).
   */
  sanityMax?:  number;
  /**
   * Minimum credible raw height (metres) before calibration.
   * If a detected object's rawDimensions.height is below this threshold it was
   * scanned as a "pancake" — a flat mesh that would produce a wildly large
   * scale factor.  The Pancake Guard in computeScaleFactor excludes such objects
   * from calibration entirely.
   */
  sanityMinHeight?: number;
  /**
   * When true, this fixture is a fixed architectural appliance used by the
   * ZoneEngine to identify functional rooms in empty units (e.g. kitchen via
   * refrigerator / stove / sink / cabinet cluster).
   */
  isArchitecturalAnchor?: boolean;
  /**
   * Standard horizontal footprint (floor plan) for OBB estimation.
   *
   * When the scan produces a suspiciously square Axis-Aligned Bounding Box for
   * a known non-square object, the Diagonal-Invariant OBB Estimator uses this
   * aspect ratio to recover the true width and depth:
   *
   *   W² + D² = W_aabb² + D_aabb²   (diagonal preserved under rotation)
   *   W / D   = widthM / depthM     (known standard aspect ratio)
   *
   * Leave unset for objects with naturally square footprints, openings, or
   * objects where footprint variation is too high to anchor (e.g. counters).
   */
  standardFootprint?: { widthM: number; depthM: number };
}

export const STANDARD_ANCHORS: StandardAnchor[] = [
  // ── Architectural ── LOW classWeight — highly variable apparent dimensions ──
  { pattern: /\bdoor(?:way)?\b|\bentry\b/i,                     dimension: "height", standard: 2.03, tier: "architectural", classWeight: 0.1, sanityMax: 3.0  },
  { pattern: /\bwindow\b/i,                                     dimension: "height", standard: 1.37, tier: "architectural", classWeight: 0.1, sanityMax: 4.0  },
  { pattern: /\barchway\b|\barch\b/i,                           dimension: "height", standard: 2.10, tier: "architectural", classWeight: 0.1, sanityMax: 5.0  },

  // ── Architectural ── MEDIUM classWeight — more predictable dimensions ───────
  { pattern: /\bcounter(?:top)?\b|\bkitchen\s+counter\b/i,      dimension: "height", standard: 0.91, tier: "architectural", classWeight: 0.4                   },
  { pattern: /\bkitchen\s+island\b/i,                           dimension: "height", standard: 0.91, tier: "architectural", classWeight: 0.4, sanityMax: 3.5  },
  { pattern: /\bstair\b|\bstep\b/i,                             dimension: "height", standard: 0.18, tier: "architectural", classWeight: 0.4, sanityMax: 3.0  },

  // ── Fixtures ── LOW classWeight — small / easily distorted ──────────────────
  { pattern: /\boutlet\b|\bsocket\b|\bpower\s+point\b/i,        dimension: "height", standard: 0.06, tier: "fixture",       classWeight: 0.1, sanityMax: 0.3  },
  { pattern: /\blight\s*switch\b|\bwall\s*switch\b/i,           dimension: "height", standard: 0.08, tier: "fixture",       classWeight: 0.1, sanityMax: 0.5  },

  // ── Fixtures ── MEDIUM classWeight ──────────────────────────────────────────
  { pattern: /\btoilet\b|\bwc\b/i,                              dimension: "height", standard: 0.40, tier: "fixture",       classWeight: 0.4, sanityMax: 1.0  },
  { pattern: /\bbath\s*tub\b|\btub\b/i,                         dimension: "height", standard: 0.58, tier: "fixture",       classWeight: 0.4, sanityMax: 1.5  },
  { pattern: /\bbathr?o?o?m?\s*sink\b|\bbasin\b|\bpedestal\s+sink\b/i, dimension: "height", standard: 0.86, tier: "fixture", classWeight: 0.4, sanityMax: 2.0 },

  // ── Furniture ── HIGH classWeight — predictable, rarely custom ───────────────
  { pattern: /\bsofa\b|\bcouch\b|\bsectional\b/i,               dimension: "height", standard: 0.86, tier: "furniture",    classWeight: 1.0, sanityMax: 4.0,  sanityMinHeight: 0.45, standardFootprint: { widthM: 2.10, depthM: 0.90 } },
  // Width-based; standard defaults to Queen (most common). computeScaleFactor
  // overrides this via the BED_LADDER nearest-neighbour heuristic at runtime.
  // sanityMinHeight guards against flat "pancake" bed scans even though this anchor uses width.
  { pattern: /\bbed\b/i,                                        dimension: "width",  standard: 1.50, tier: "furniture",    classWeight: 1.0, sanityMax: 2.2,  sanityMinHeight: 0.30, standardFootprint: { widthM: 1.50, depthM: 2.00 } },
  { pattern: /\bdining\s+table\b/i,                             dimension: "height", standard: 0.76, tier: "furniture",    classWeight: 1.0, sanityMax: 3.0,  standardFootprint: { widthM: 1.50, depthM: 0.90 } },
  { pattern: /\brefrigerator\b|\bfridge\b/i,                    dimension: "height", standard: 1.70, tier: "fixture",      classWeight: 0.4, sanityMax: 2.5,  sanityMinHeight: 0.45, standardFootprint: { widthM: 0.70, depthM: 0.70 }, isArchitecturalAnchor: true },
  // ── Architectural Anchors — fixed kitchen fixtures for empty-unit zone mapping ─
  { pattern: /\bstove\b|\brange\b/i,                            dimension: "height", standard: 0.91, tier: "fixture",      classWeight: 0.4, sanityMax: 1.5,  isArchitecturalAnchor: true },
  { pattern: /\bsink\b/i,                                       dimension: "height", standard: 0.91, tier: "fixture",      classWeight: 0.4, sanityMax: 1.5,  isArchitecturalAnchor: true },
  { pattern: /\bcabinet\b/i,                                    dimension: "height", standard: 0.91, tier: "fixture",      classWeight: 0.4, sanityMax: 2.4,  isArchitecturalAnchor: true },

  // ── Furniture ── MEDIUM classWeight ─────────────────────────────────────────
  { pattern: /\bchair\b|\bdining\s+chair\b|\barmchair\b/i,      dimension: "height", standard: 0.46, tier: "furniture",    classWeight: 0.4, sanityMax: 1.5  },
  { pattern: /\bdesk\b|\bwriting\s+table\b/i,                   dimension: "height", standard: 0.76, tier: "furniture",    classWeight: 0.4, sanityMax: 3.0  },
  { pattern: /\bwardrobe\b|\barmoire\b|\bcloset\b/i,             dimension: "height", standard: 2.10, tier: "furniture",    classWeight: 0.4, sanityMax: 4.0,  standardFootprint: { widthM: 1.20, depthM: 0.58 } },
  { pattern: /\bbookshelf\b|\bbookcase\b/i,                     dimension: "height", standard: 1.80, tier: "furniture",    classWeight: 0.4, sanityMax: 4.0  },
  { pattern: /\bdresser\b|\bchest\s+of\s+drawers\b/i,           dimension: "height", standard: 1.20, tier: "furniture",    classWeight: 0.4, sanityMax: 2.5  },
  { pattern: /\bcoffee\s+table\b|\bcenter\s+table\b|\bcentre\s+table\b/i, dimension: "height", standard: 0.42, tier: "furniture", classWeight: 0.4, sanityMax: 1.5 },
  { pattern: /\bend\s+table\b|\bnightstand\b|\bnight\s*stand\b/i,         dimension: "height", standard: 0.60, tier: "furniture", classWeight: 0.4, sanityMax: 1.2 },
];

/**
 * Tier weights — used only by HybridValidation (applyHybridValidation).
 * Scale calibration now uses StandardAnchor.classWeight instead.
 */
export const TIER_WEIGHTS: Record<StandardAnchor["tier"], number> = {
  architectural: 3,
  fixture:       2,
  furniture:     1,
};
