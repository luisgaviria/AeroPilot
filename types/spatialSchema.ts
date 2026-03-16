/**
 * Zod schemas for validated Supabase persistence.
 *
 * Every value written to or read from the database passes through these
 * schemas.  If validation fails, the operation is aborted and a
 * [Spatial-Integrity-Error] is logged — no corrupt data is ever persisted.
 */
import { z } from "zod";

// ── Primitives ─────────────────────────────────────────────────────────────────

/** Rejects NaN, Infinity, and non-number types. */
const strictNum = z.number().finite().refine((n) => !isNaN(n), {
  message: "Value must be a finite, non-NaN number",
});

/** A strictly positive finite number. */
const posNum = strictNum.positive();

// ── Sub-schemas ───────────────────────────────────────────────────────────────

/**
 * Low-resolution spatial map stored per entity.
 * Mirrors ObjectInventoryEntry.map in types/spatialDigest.ts.
 */
export const MapSchema = z.object({
  x: strictNum,
  z: strictNum,
  w: posNum,
  d: posNum,
});

export const SpatialStatsSchema = z.object({
  floor_occupancy_pct:  z.number().min(0).max(100).nullable(),
  tightest_clearance_m: z.number().nullable(),
  max_wall_available_m: z.number().nullable(),
});

export const OccupancyTierSchema = z.enum(["primary", "secondary", "architectural"]);

export const SpatialModeSchema = z.enum(["room", "open-plan", "outdoor", "aerial"]);

// ── Top-level schemas ─────────────────────────────────────────────────────────

/**
 * Validated room row written to / read from the `rooms` table.
 * `verified_x/y/z_axis` mirror the store's verifiedXAxis / Y / Z fields
 * and are the authoritative ground truth for room geometry.
 * `spatial_mode` controls how the AI interprets the space.
 */
export const RoomSchema = z.object({
  name:                z.string().min(1),
  verified_dimensions: z.object({
    width:  posNum,
    length: posNum,
    height: posNum,
  }),
  verified_x_axis: strictNum.nullable().optional(),
  verified_y_axis: strictNum.nullable().optional(),
  verified_z_axis: strictNum.nullable().optional(),
  spatial_stats:   SpatialStatsSchema.optional(),
  spatial_mode:    SpatialModeSchema.optional(),
});

/**
 * Validated entity row written to / read from the `spatial_entities` table.
 * `map` is nullable so objects detected but not yet fully measured can still
 * be persisted with their label and tier.
 */
export const EntitySchema = z.object({
  label:         z.string().min(1),
  occupancy_tier: OccupancyTierSchema,
  map:           MapSchema.nullable(),
  is_verified:   z.boolean(),
});

// ── Inferred types ────────────────────────────────────────────────────────────

export type SpatialMode         = z.infer<typeof SpatialModeSchema>;
export type RoomPayload         = z.infer<typeof RoomSchema>;
export type EntityPayload       = z.infer<typeof EntitySchema>;
export type MapPayload          = z.infer<typeof MapSchema>;
export type SpatialStatsPayload = z.infer<typeof SpatialStatsSchema>;
