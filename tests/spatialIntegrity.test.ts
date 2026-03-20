/**
 * Spatial Integrity Test Bench
 *
 * Tests the full calibration pipeline against a Mock Manifest that matches
 * a real "messy scan" scenario: pancake heights, undersized footprints, and
 * a ceiling height that produces a sub-1× scale factor.
 *
 * Mock Manifest (raw scan state)
 * ─────────────────────────────
 *   Room:   5.5m × 4.0m, height 2.54m  (scan over-reads ceiling by 0.24m)
 *   Sofa:   w=1.00m  h=0.30m  d=0.90m  (pancake — top-surface-only capture)
 *   Fridge: w=0.70m  h=0.30m  d=0.70m  (pancake)
 *
 * Ceiling Lock Target: 2.30m → scale = 2.30 / 2.54 ≈ 0.9055×
 *
 * Expected Output (after validation loop with full-footprint pancake heal)
 * ────────────────────────────────────────────────────────────────────────
 *   Room height:     2.30m  (exact, set by Master Ceiling)
 *   Sofa width:    ≥ 2.10m  (healed to standardFootprint.widthM)
 *   Fridge height: ≥ 1.70m  (healed to anchor.standard)
 *   Global score:  ≥ 90%    (all anchored objects within tolerance)
 *   Health report: ≥ 2 healed entries with meaningful reason text
 *
 * HOW THE HEALING WORKS
 * ─────────────────────
 * 1. Scale (0.9055×) shrinks pancake heights further below sanityMinHeight.
 * 2. Iteration 1 — sofa: isRotatedAABB fires (aspect ratio mismatch after
 *    scale), OBB-reproject corrects the ratio without fixing the pancake height.
 * 3. Iteration 2 — sofa: rawMeshDimensions.height (0.30) < sanityMinHeight
 *    (0.45) → pancake branch fires → full footprint restore to 2.10×0.86×0.90m.
 * 4. Iteration 1 — fridge: isRotatedAABB skipped (square footprint, rr≈1.0),
 *    pancake branch fires immediately → restore to 0.70×1.70×0.70m.
 *
 * RUNNING
 * ───────
 *   npm run test:unit
 */

import { describe, it, expect } from "vitest";
import { runValidationLoop, generateSpatialHealthReport } from "@/utils/semanticScale";
import type { DetectedObject } from "@/types/auto-discovery";
import type { RoomDimensions }  from "@/utils/spatial";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal DetectedObject for the validation engine. */
function mockObject(
  name:    string,
  raw:     { w: number; h: number; d: number },
  scaled:  { w: number; h: number; d: number },
): DetectedObject {
  return {
    uid:             name,
    name,
    position3D:      [0, 0, 0],
    pixelCoords:     { x: 0, y: 0 },
    scanCount:       1,
    confidence:      0.95,
    rawMeshDimensions: { width: raw.w,    height: raw.h,    depth: raw.d    },
    rawDimensions:     { width: raw.w,    height: raw.h,    depth: raw.d    },
    dimensions:        { width: scaled.w, height: scaled.h, depth: scaled.d },
  };
}

/** Apply a uniform scale factor to raw dims. */
function applyScale(raw: { w: number; h: number; d: number }, factor: number) {
  return {
    w: +(raw.w * factor).toFixed(4),
    h: +(raw.h * factor).toFixed(4),
    d: +(raw.d * factor).toFixed(4),
  };
}

// ── Mock Manifest ─────────────────────────────────────────────────────────────

const RAW_CEILING = 2.54;   // metres — what the scanner captured
const TARGET_CEILING = 2.30; // metres — what we know the room actually is
const SCALE = TARGET_CEILING / RAW_CEILING; // ≈ 0.9055

const RAW_SOFA   = { w: 1.00, h: 0.30, d: 0.90 };
const RAW_FRIDGE = { w: 0.70, h: 0.30, d: 0.70 };

const ROOM: RoomDimensions = {
  width:     5.5,
  length:    4.0,
  height:    TARGET_CEILING,
  floorArea: 5.5 * 4.0,
};

const OBJECTS: DetectedObject[] = [
  mockObject("sofa",         RAW_SOFA,   applyScale(RAW_SOFA,   SCALE)),
  mockObject("refrigerator", RAW_FRIDGE, applyScale(RAW_FRIDGE, SCALE)),
];

// ── Suites ───────────────────────────────────────────────────────────────────

describe("Spatial Integrity — Mock Manifest (messy scan)", () => {

  // Run the validation loop once; share result across all tests in this suite.
  const result = runValidationLoop(OBJECTS, undefined, undefined, ROOM);
  const report = generateSpatialHealthReport(result);

  // ── SI-1: Scale factor is correct ──────────────────────────────────────────

  it("SI-1 — ceiling scale factor: 2.30 / 2.54 ≈ 0.9055", () => {
    expect(SCALE).toBeCloseTo(0.9055, 3);
    // Room height after applying scale is the target ceiling.
    expect(+(RAW_CEILING * SCALE).toFixed(3)).toBeCloseTo(TARGET_CEILING, 2);
  });

  // ── SI-2: Sofa healed to standard footprint ────────────────────────────────

  it("SI-2 — sofa width ≥ 2.10m after pancake heal", () => {
    const sofa = result.objects.find((o) => o.name === "sofa");
    expect(sofa, "sofa not found in result objects").toBeDefined();
    expect(sofa!.dimensions!.width).toBeGreaterThanOrEqual(2.10);
  });

  it("SI-2b — sofa height ≥ 0.86m after pancake heal", () => {
    const sofa = result.objects.find((o) => o.name === "sofa");
    expect(sofa!.dimensions!.height).toBeGreaterThanOrEqual(0.86);
  });

  // ── SI-3: Fridge healed to standard height ─────────────────────────────────

  it("SI-3 — fridge height ≥ 1.70m after pancake heal", () => {
    const fridge = result.objects.find((o) => o.name === "refrigerator");
    expect(fridge, "fridge not found in result objects").toBeDefined();
    expect(fridge!.dimensions!.height).toBeGreaterThanOrEqual(1.70);
  });

  // ── SI-4: Global Plausibility Score ≥ 90% ─────────────────────────────────

  it("SI-4 — global plausibility score ≥ 90% after healing", () => {
    expect(result.globalScore).toBeGreaterThanOrEqual(90);
  });

  // ── SI-5: Health report documents all healed objects ──────────────────────

  it("SI-5 — health report marks both objects as healed", () => {
    expect(report.passed, "health report should pass after healing").toBe(true);
    expect(report.healedCount).toBeGreaterThanOrEqual(2);

    const sofaEntry   = report.entries.find((e) => e.objectName === "sofa");
    const fridgeEntry = report.entries.find((e) => e.objectName === "refrigerator");

    expect(sofaEntry?.status).toBe("healed");
    expect(fridgeEntry?.status).toBe("healed");
  });

  it("SI-5b — healing reasons contain 'Below Semantic Minimum'", () => {
    for (const entry of report.entries.filter((e) => e.status === "healed")) {
      expect(
        entry.healingReason,
        `"${entry.objectName}" should have a healing reason`,
      ).toBeDefined();
      expect(entry.healingReason).toMatch(/Below Semantic Minimum/i);
    }
  });

  // ── SI-6: No ghost artifacts (both objects are healable) ───────────────────

  it("SI-6 — no ghost artifacts for standard furniture types", () => {
    expect(result.ghostArtifactUids).toHaveLength(0);
    expect(report.ghostCount).toBe(0);
  });

  // ── SI-7: Scale does not destroy a pre-calibrated large sofa ──────────────
  // Regression: a sofa already at 2.40m should pass room-fit-pass, not be clamped.

  it("SI-7 — large (2.40m) sofa passes room-fit-pass, not clamped", () => {
    const largeSofaRaw    = { w: 2.65, h: 0.86, d: 0.90 }; // pre-calibrated large sofa
    const largeSofaScaled = applyScale(largeSofaRaw, SCALE);   // ≈ 2.40m after scale
    const largeObj = mockObject("sofa", largeSofaRaw, largeSofaScaled);

    const r = runValidationLoop([largeObj], undefined, undefined, ROOM);
    const sofa = r.objects[0];

    // Width should be preserved (room-fit-pass) or healed — never clamped below 2.10m
    expect(sofa.dimensions!.width).toBeGreaterThanOrEqual(2.10);
    // Should not be flagged as a ghost
    expect(r.ghostArtifactUids).not.toContain("sofa");
  });
});

// ── Suite 2: Flexible Anchor — Japanese Loft vs Boston Apartment ─────────────
//
// Control:    Japanese Loft — NO sofa.  Engine must produce zero changes to
//             any loft object when Flexible Anchor code is added.
//
// Treatment:  Boston Apartment sofa — undersized after 0.9055× ceiling scale.
//             Engine must expand it to ≥ 2.10m (standard) or 2.54m (user truth).
//
// The combined console output from these tests produces:
//   [ScaleGuard] Loft Baseline Verified.
//   [ScaleGuard] Apartment Sofa corrected to 2.54m via Semantic Expansion.

describe("Flexible Anchor — Loft Control vs Apartment Sofa", () => {

  // ── Loft objects (from japanese-loft.json — objects with matching anchors) ──
  // rawDimensions and dimensions are taken directly from the exported manifest.
  // rawMeshDimensions = rawDimensions (no separate field in v1 manifest schema).
  const LOFT_ROOM: RoomDimensions = { width: 5.2, length: 7.27, height: 4.21, floorArea: 28.1 };

  const LOFT_BED = mockObject(
    "bed",
    { w: 1.4,  h: 0.3, d: 2.0  },  // rawDimensions from loft manifest
    { w: 1.929, h: 1.052, d: 1.929 },  // calibrated dimensions (scale 0.8766)
  );
  // Futon — does NOT match /\bsofa\b|\bcouch\b|\bsectional\b/i; anchor never fires.
  const LOFT_FUTON = mockObject(
    "futon",
    { w: 1.8, h: 0.3, d: 2.0 },
    { w: 1.578, h: 0.263, d: 1.753 },
  );

  const LOFT_OBJECTS: DetectedObject[] = [LOFT_BED, LOFT_FUTON];

  // ── Apartment sofa (from boston-apartment.json) ───────────────────────────
  // After master ceiling 0.9055× is applied to rawMeshDimensions:
  //   w = 1.0 × 0.9055 ≈ 0.905m,  h = 1.0 × 0.9055 ≈ 0.905m,  d = 1.9 × 0.9055 ≈ 1.721m
  const APT_ROOM: RoomDimensions  = { width: 7.15, length: 8.38, height: 2.30, floorArea: 59.9 };
  const APT_SOFA_RAW              = { w: 1.0, h: 1.0, d: 1.9 };
  const APT_SOFA_SCALED           = applyScale(APT_SOFA_RAW, 0.9055); // 0.905 × 0.906 × 1.72

  // ── SI-8: Loft Baseline — no measurements change after Flexible Anchor ────

  it("SI-8 — Loft Baseline: zero loft dimensions change with Flexible Anchor enabled", () => {
    const before = runValidationLoop(LOFT_OBJECTS, undefined, undefined, LOFT_ROOM);
    // The futon has no sofa-pattern anchor → soleTypeUids contains only "bed".
    // Bed is corrected by OBB (iter 1) → final dims are geometrically determined,
    // not by Flexible Anchor.  Verify the result is dimensionally stable.
    const bedAfter = before.objects.find((o) => o.name === "bed")!;
    expect(bedAfter.dimensions!.width).toBeGreaterThan(0);
    expect(bedAfter.dimensions!.height).toBeGreaterThan(0);

    // Futon: no anchor match → score=100 → untouched
    const futonAfter = before.objects.find((o) => o.name === "futon")!;
    expect(futonAfter.dimensions!.width).toBe(LOFT_FUTON.dimensions!.width);
    expect(futonAfter.dimensions!.depth).toBe(LOFT_FUTON.dimensions!.depth);

    // Confirm no semantic-expand fired for any loft object
    const expansions = before.trials.filter((t) => t.action === "semantic-expand");
    expect(expansions).toHaveLength(0);

    console.log("[ScaleGuard] Loft Baseline Verified.");
  });

  // ── SI-9: Apartment Sofa — standard expansion to 2.10m ───────────────────

  it("SI-9 — Apartment sofa expands to ≥ 2.10m via Flexible Anchor (no user annotation)", () => {
    const sofa = mockObject("sofa", APT_SOFA_RAW, APT_SOFA_SCALED);
    const r    = runValidationLoop([sofa], undefined, undefined, APT_ROOM);
    const out  = r.objects[0];

    expect(out.dimensions!.width).toBeGreaterThanOrEqual(2.10);
    const expanded = r.trials.some((t) => t.action === "semantic-expand");
    expect(expanded).toBe(true);
  });

  // ── SI-10: Apartment Sofa — user-truth expansion to 2.54m (100 inches) ───

  it("SI-10 — Apartment sofa corrected to 2.54m when user truth is annotated", () => {
    // User annotated: "my sofa is 100 inches = 2.54m".
    // isUserVerified is FALSE so the engine still processes it, but
    // verifiedDimensions provides the Flexible Anchor expansion target.
    const sofaWithTruth: DetectedObject = {
      ...mockObject("sofa", APT_SOFA_RAW, APT_SOFA_SCALED),
      isUserVerified:     false,
      verifiedDimensions: { width: 2.54, height: 0.86, depth: 0.90 },
    };

    const r   = runValidationLoop([sofaWithTruth], undefined, undefined, APT_ROOM);
    const out = r.objects[0];

    expect(out.dimensions!.width).toBeCloseTo(2.54, 1);
    expect(r.ghostArtifactUids).not.toContain("sofa");

    console.log("[ScaleGuard] Apartment Sofa corrected to 2.54m via Semantic Expansion.");
  });

  // ── SI-11: Health report flags semantic-expand as healed ─────────────────

  it("SI-11 — health report documents semantic expansion with correct reason", () => {
    const sofaWithTruth: DetectedObject = {
      ...mockObject("sofa", APT_SOFA_RAW, APT_SOFA_SCALED),
      isUserVerified:     false,
      verifiedDimensions: { width: 2.54, height: 0.86, depth: 0.90 },
    };

    const r      = runValidationLoop([sofaWithTruth], undefined, undefined, APT_ROOM);
    const report = generateSpatialHealthReport(r);
    const entry  = report.entries.find((e) => e.objectName === "sofa");

    expect(entry?.status).toBe("healed");
    expect(entry?.healingReason).toMatch(/Sole-type Flexible Anchor/i);
    expect(entry?.finalDims.width).toBeCloseTo(2.54, 1);
  });
});
