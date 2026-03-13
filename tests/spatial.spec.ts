/**
 * Spatial Sanity E2E Suite — "Blind" mode
 *
 * These tests are label-agnostic: they make no assumptions about which mesh
 * is named "bed" or where it sits in the GLB.  All assertions are driven purely
 * by geometric measurements.
 *
 * HOW IT WORKS
 * ─────────────
 * SpatialTestBridge.tsx exposes window.__vistaSpatialTest__ once the R3F scene
 * has mounted.  Tests call measureAt(pos, radius) which invokes getObjectMeshBounds
 * directly on the live Three.js scene — no Gemini API call required.
 *
 * COORDINATE SYSTEM
 * ─────────────────
 * The GLB is centred at origin with the floor at Y = 0.
 * A 5×5 grid at Y = 0.5 m covers most residential living spaces (±2 m radius).
 */

import { test, expect } from "@playwright/test";
import mockData from "./mocks/spatial_mock.json";

// ─── Shared types ────────────────────────────────────────────────────────────

interface SpatialResult {
  width:      number;
  height:     number;
  depth:      number;
  center:     [number, number, number];
  voxelCount: number;
  clipping_warning?: boolean;
}

interface DynamicBounds {
  minX: number; maxX: number;
  minY: number; maxY: number;
  minZ: number; maxZ: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function waitForScene(page: import("@playwright/test").Page) {
  await page.waitForFunction(
    () => !!(window as any).__vistaSpatialTest__?.ready,
    { timeout: 45_000 },
  );
}

async function getDynamicBounds(page: import("@playwright/test").Page): Promise<DynamicBounds> {
  return page.evaluate(() => (window as any).__vistaSpatialTest__.dynamicBounds as DynamicBounds);
}

/**
 * Sweep a 5×5 grid (25 positions) at the given Y height across ±2 m and
 * call measureAt on each.  Returns every non-null result sorted by width desc.
 * All 25 calls run inside a single page.evaluate — no round-trips per position.
 */
async function gridSweep(
  page:   import("@playwright/test").Page,
  y:      number,
  radius: number,
): Promise<SpatialResult[]> {
  return page.evaluate(
    ([y, radius]) => {
      const test = (window as any).__vistaSpatialTest__;
      const results: SpatialResult[] = [];
      for (let xi = -2; xi <= 2; xi++) {
        for (let zi = -2; zi <= 2; zi++) {
          const r: SpatialResult | null = test.measureAt([xi, y, zi], radius);
          if (r && r.width > 0 && r.height > 0) results.push(r);
        }
      }
      return results.sort((a: SpatialResult, b: SpatialResult) => b.width - a.width);
    },
    [y, radius] as [number, number],
  );
}

// ─── Suite ───────────────────────────────────────────────────────────────────

test.describe("Spatial Sanity — Blind Geometric Suite", () => {
  test.beforeEach(async ({ page }) => {
    // Intercept Vision API calls — spatial tests use measureAt() directly and
    // must never trigger real API traffic.
    await page.route("**/api/chat", async (route) => {
      const body = route.request().postDataJSON() as { mode?: string } | null;
      const payload = body?.mode === "discover" ? mockData.discover : mockData.chat;
      await route.fulfill({
        status:      200,
        contentType: "application/json",
        body:        JSON.stringify(payload),
      });
    });

    await page.goto("/");
    await waitForScene(page);
  });

  // ── XYZ_1: widest object in the room must exceed 1.5 m (bed / sofa / table) ──

  test("XYZ_1 — widest geometric mass exceeds 1.5 m", async ({ page }) => {
    // Sweep at two heights to catch both low furniture (40 cm) and taller pieces (80 cm)
    const low  = await gridSweep(page, 0.4, 3.0);
    const high = await gridSweep(page, 0.8, 3.0);
    const all  = [...low, ...high];

    expect(all.length, "Grid sweep returned no results — GLB not loaded?").toBeGreaterThan(0);

    const widest = all[0];
    console.log(
      `[XYZ_1] widest cluster: ${widest.width.toFixed(2)} × ${widest.height.toFixed(2)} × ${widest.depth.toFixed(2)} m` +
      ` | voxels=${widest.voxelCount} | center=(${widest.center.map(n => n.toFixed(2)).join(", ")})`
    );

    expect(widest.width).toBeGreaterThan(1.5);
    expect(widest.voxelCount, "Cluster too sparse — slab detection may have failed").toBeGreaterThan(20);
  });

  // ── XYZ_2: smaller objects are stable within 10 % across two identical calls ──

  test("XYZ_2 — cabinet-scale objects are deterministically stable (within 10 %)", async ({ page }) => {
    // Find the narrowest "furniture-scale" cluster (0.3–1.2 m wide) — that's
    // the cabinet / nightstand / end-table range, never a bed or sofa.
    const results = await gridSweep(page, 0.8, 2.0);
    const cabinetRange = results.filter(r => r.width >= 0.3 && r.width <= 1.2);

    if (cabinetRange.length === 0) {
      test.skip(); // No cabinet-scale object found — skip instead of fail
      return;
    }

    const ref = cabinetRange[0];
    console.log(
      `[XYZ_2] reference cluster: ${ref.width.toFixed(2)} × ${ref.height.toFixed(2)} × ${ref.depth.toFixed(2)} m` +
      ` | center=(${ref.center.map(n => n.toFixed(2)).join(", ")})`
    );

    // Measure the exact same world-space point a second time
    const second: SpatialResult | null = await page.evaluate(
      ([center]) => (window as any).__vistaSpatialTest__.measureAt(center, 2.0),
      [ref.center],
    );

    expect(second, "Second measurement returned null for the same position").not.toBeNull();

    const widthDelta  = Math.abs(second!.width  - ref.width)  / ref.width;
    const depthDelta  = Math.abs(second!.depth  - ref.depth)  / ref.depth;
    const heightDelta = Math.abs(second!.height - ref.height) / ref.height;

    console.log(
      `[XYZ_2] deltas: width=${(widthDelta*100).toFixed(1)}%` +
      ` depth=${(depthDelta*100).toFixed(1)}% height=${(heightDelta*100).toFixed(1)}%`
    );

    expect(widthDelta,  "Width changed > 10 % between identical calls").toBeLessThan(0.10);
    expect(depthDelta,  "Depth changed > 10 % between identical calls").toBeLessThan(0.10);
    expect(heightDelta, "Height changed > 10 % between identical calls").toBeLessThan(0.10);
  });

  // ── Engine smoke tests ───────────────────────────────────────────────────────

  test("scene is populated — at least one cluster found in the room", async ({ page }) => {
    const results = await gridSweep(page, 0.5, 5.0);
    expect(results.length, "No furniture found — GLB may be missing or mis-centred").toBeGreaterThan(0);
  });

  test("all returned dimensions are non-negative and physically plausible", async ({ page }) => {
    const results = await gridSweep(page, 0.5, 3.0);

    for (const r of results) {
      expect(r.width).toBeGreaterThanOrEqual(0);
      expect(r.height).toBeGreaterThanOrEqual(0);
      expect(r.depth).toBeGreaterThanOrEqual(0);
      // Sanity upper-bound: no single piece of furniture exceeds 6 m
      expect(r.width).toBeLessThan(6);
      expect(r.height).toBeLessThan(6);
      expect(r.depth).toBeLessThan(6);
    }
  });

  // ── GEO_1: dynamicBounds must be a valid room enclosure ──────────────────────

  test("GEO_1 — dynamicBounds is a valid non-degenerate room enclosure", async ({ page }) => {
    const b = await getDynamicBounds(page);

    expect(b.maxX, "maxX must exceed minX").toBeGreaterThan(b.minX);
    expect(b.maxY, "maxY must exceed minY").toBeGreaterThan(b.minY);
    expect(b.maxZ, "maxZ must exceed minZ").toBeGreaterThan(b.minZ);

    // Room must be at least 2 m in each horizontal axis
    expect(b.maxX - b.minX).toBeGreaterThan(2);
    expect(b.maxZ - b.minZ).toBeGreaterThan(2);

    // Ceiling must be between 1.5 m and 5 m
    expect(b.maxY).toBeGreaterThan(1.5);
    expect(b.maxY).toBeLessThan(5.0);

    console.log(
      `[GEO_1] bounds: X[${b.minX},${b.maxX}] Y[${b.minY},${b.maxY}] Z[${b.minZ},${b.maxZ}]`
    );
  });

  // ── GEO_2: measurements at 3 coordinates are within detected room bounds ─────

  test("GEO_2 — measurements at 3 coordinates are non-zero and within room bounds", async ({ page }) => {
    const b = await getDynamicBounds(page);

    const probes: [number, number, number][] = [
      [ 1.0, 0.5,  1.0],
      [-1.0, 0.5, -1.0],
      [ 0.5, 0.8,  0.5],
    ];

    for (const pos of probes) {
      const r: SpatialResult | null = await page.evaluate(
        ([p]) => (window as any).__vistaSpatialTest__.measureAt(p, 3.0),
        [pos] as [[number, number, number]],
      );

      if (!r) {
        console.log(`[GEO_2] probe (${pos.join(", ")}) returned null — no geometry nearby, skipping`);
        continue;
      }

      expect(r.width * r.height * r.depth, `Volume at (${pos.join(",")}) must be positive`).toBeGreaterThan(0);

      const roomW = b.maxX - b.minX;
      const roomH = b.maxY - b.minY;
      const roomD = b.maxZ - b.minZ;

      expect(r.width,  `width at (${pos.join(",")}) exceeds room width`)  .toBeLessThanOrEqual(roomW + 0.1);
      expect(r.height, `height at (${pos.join(",")}) exceeds room height`).toBeLessThanOrEqual(roomH + 0.1);
      expect(r.depth,  `depth at (${pos.join(",")}) exceeds room depth`)  .toBeLessThanOrEqual(roomD + 0.1);

      if (r.clipping_warning) {
        console.warn(`[GEO_2] clipping_warning=true at (${pos.join(", ")}) — result may be truncated`);
      }

      console.log(
        `[GEO_2] (${pos.join(", ")}): ${r.width.toFixed(2)}×${r.height.toFixed(2)}×${r.depth.toFixed(2)} m` +
        (r.clipping_warning ? " ⚠ CLIPPED" : "")
      );
    }
  });

  // ── GEO_3: physics consistency — two identical calls must agree within 2 % ───

  test("GEO_3 — physics consistency: identical probe agrees within 2 %", async ({ page }) => {
    // Use the same probe the grid sweep would most likely hit solid geometry
    const probe: [number, number, number] = [1, 0.5, -1];

    const first: SpatialResult | null = await page.evaluate(
      ([p]) => (window as any).__vistaSpatialTest__.measureAt(p, 3.0),
      [probe] as [[number, number, number]],
    );

    if (!first || first.voxelCount === 0) {
      test.skip(); // no geometry at this probe — not an error
      return;
    }

    const second: SpatialResult | null = await page.evaluate(
      ([p]) => (window as any).__vistaSpatialTest__.measureAt(p, 3.0),
      [probe] as [[number, number, number]],
    );

    expect(second, "Second identical measurement must not be null").not.toBeNull();

    const widthDelta  = Math.abs(second!.width  - first.width)  / Math.max(first.width,  0.01);
    const depthDelta  = Math.abs(second!.depth  - first.depth)  / Math.max(first.depth,  0.01);
    const heightDelta = Math.abs(second!.height - first.height) / Math.max(first.height, 0.01);

    console.log(
      `[GEO_3] first: ${first.width.toFixed(2)}×${first.height.toFixed(2)}×${first.depth.toFixed(2)} m | ` +
      `deltas: width=${(widthDelta*100).toFixed(1)}% depth=${(depthDelta*100).toFixed(1)}% height=${(heightDelta*100).toFixed(1)}%`
    );

    expect(widthDelta,  "Width changed > 2% between identical calls").toBeLessThan(0.02);
    expect(depthDelta,  "Depth changed > 2% between identical calls").toBeLessThan(0.02);
    expect(heightDelta, "Height changed > 2% between identical calls").toBeLessThan(0.02);
  });
});
