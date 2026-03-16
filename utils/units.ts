/**
 * Unit-formatting helpers shared by DiagnosticDashboard and TourOverlay.
 *
 * Precision rules (per product spec):
 *   Metric  — 1 decimal place (2.4 m, 19.2 m²)
 *   Imperial — nearest whole inch for lengths (7'11"), whole sq ft for areas
 */

/** Format metres to 1 decimal place: "2.4 m" */
export function fmtM(m: number): string {
  return `${m.toFixed(1)} m`;
}

/**
 * Convert metres to feet-and-inches rounded to the nearest whole inch.
 * Handles carry-over: 5'12" becomes 6'0".
 * Examples: 2.44 → "8'0\"" | 2.40 → "7'10\"" | 3.05 → "10'0\""
 */
export function fmtFtIn(m: number): string {
  const totalIn = m / 0.0254;
  const ft      = Math.floor(totalIn / 12);
  const inches  = Math.round(totalIn % 12);
  if (inches === 12) return `${ft + 1}'0"`;
  return `${ft}'${inches}"`;
}

/**
 * Dual-unit linear dimension: "2.4 m / 7'11\""
 * Used for height, length, width fields where tape-measure readability matters.
 */
export function fmtLen(m: number): string {
  return `${fmtM(m)} / ${fmtFtIn(m)}`;
}

/**
 * Format a square-metre area with its sq-ft equivalent.
 * "19.2 m² (207 sq ft)"
 */
export function fmtArea(m2: number): string {
  const sqft = Math.round(m2 * 10.7639);
  return `${m2.toFixed(1)} m² (${sqft} sq ft)`;
}
