import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { NextRequest, NextResponse } from "next/server";
import { locations } from "@/data/locations";
import type { SpatialDigest } from "@/types/spatialDigest";
import type { SpatialMode } from "@/types/spatialSchema";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

// ─── Shared helpers ────────────────────────────────────────────────────────────

const validIds = Object.keys(locations);

const locationContext = Object.values(locations)
  .map((loc) => `  "${loc.id}" — ${loc.label}`)
  .join("\n");

// ─── Chat mode (room navigation) ───────────────────────────────────────────────

interface RoomDimensions { width: number; length: number; height: number; floorArea?: number; }

function mToFtIn(m: number): string {
  const totalInches = m / 0.0254;
  const ft = Math.floor(totalInches / 12);
  const inches = Math.round(totalInches % 12);
  return `${ft}′${inches}″`;
}

function buildChatInstruction(
  roomDimensions:  RoomDimensions | null,
  spatialDigest:   SpatialDigest | null,
  currentRoomName: string | null,
  spatialMode:     SpatialMode = "room",
  globalScale:     { x: number; y: number; z: number } | null = null,
  lockedScale:     number | null = null,
): string {
  const spaceName = currentRoomName ?? "this property";

  const lines: string[] = [
    // ── Identity ──────────────────────────────────────────────────────────────
    `You are AeroPilot, a Spatial Intelligence Agent guiding a 3D property tour.`,
    `Your PRIMARY job is to navigate the user between rooms. You can ALSO answer spatial questions.`,
    ``,
    `AVAILABLE LOCATION IDs (use EXACTLY as written):`,
    locationContext,
    ``,
    `NAVIGATION RULES:`,
    `1. You MUST always return a locationId. If answering a spatial question (not navigating), return "current".`,
    `2. locationId MUST be one of the IDs above, or "current". No other value is valid.`,
    `3. If navigating, message should be 1–2 sentences: welcoming and vivid.`,
    `4. If answering a spatial question, message should be concise and factual.`,
    `5. Do not add any keys beyond locationId and message.`,
    ``,
    // ── Property Identity & Neutrality ──────────────────────────────────────────
    `STRICT NEUTRALITY:`,
    `  You are property-agnostic. NEVER assume location (e.g. "Medellin"), city,`,
    `  country, style, or type (e.g. "loft", "apartment", "villa") unless the user`,
    `  explicitly states it.`,
    `  This space is called: "${spaceName}".`,
    `  Always refer to the space using that name, or as "this property".`,
    `  If the user renames the space during the conversation, acknowledge the new`,
    `  name immediately as the authoritative name: "Got it — I'll refer to this space`,
    `  as [new name] from now on." and use it for all subsequent answers.`,
    ``,
    // ── Spatial Mode — single-line context hint (do not override measurement rules) ──
    `SPATIAL MODE: ${spatialMode}` + (
      spatialMode === "room"      ? " — enclosed interior. Ceiling height is relevant." :
      spatialMode === "open-plan" ? " — open interior. Ceiling less relevant; focus on floor-plane zones." :
      spatialMode === "outdoor"   ? " — outdoor space. Ignore ceiling; focus on ground-plane clearances." :
                                    " — aerial view. 2D ground-plane footprint only; ignore ceiling and walls."
    ),
    ``,
    // ── Spatial Reasoning Approach ────────────────────────────────────────────
    `SPATIAL REASONING APPROACH:`,
    `  ▶ CRITICAL — YOU ARE A PRECISION INSTRUMENT:`,
    `  If the Spatial Digest contains a measurement, use it EXACTLY — never round it`,
    `  further or soften it with "roughly" or "about" when a decimal value is available.`,
    `  Reserve approximate language only for Level-2 map estimates (no pre-calculated gap).`,
    ``,
    `  ▶ OCCUPANCY PRIORITY ORDER — address items in this sequence:`,
    `  1. Primary occupancy (sofa, bed, dining table, desk, wardrobe, bookcase)`,
    `  2. Secondary occupancy (coffee table, side table, chair, lamp, rug)`,
    `  3. Architectural (door, window, opening) — never block these paths.`,
    `  When asked about "what's in the room", list primary items first.`,
    ``,
    `  The scan engine has pre-computed all clearances for you — the math is already done.`,
    `  Your job is to translate these values into human-centric room-flow advice.`,
    `  DO NOT perform or output raw arithmetic. DO NOT refuse to answer spatial questions.`,
    ``,
    `  TWO-LEVEL SPATIAL TRUTH:`,
    `  Level 1 — Pre-calculated gaps (objectGaps): always use these first when available.`,
    `  Level 2 — Object map (x, z, w, d in the Room Inventory): use this as a secondary`,
    `    truth when a specific gap is not pre-calculated. From any two objects' map values`,
    `    you can estimate the distance between them. ALWAYS give the user an answer.`,
    `    Example: "Based on the map positions, there appears to be roughly X m between`,
    `    the sofa and the table — a fresh scan will give the exact figure."`,
  ];

  if (roomDimensions) {
    const { width, length, height } = roomDimensions;
    lines.push(
      ``,
      `ROOM DIMENSIONS (user-verified, authoritative):`,
      `  Width : ${width} m (${mToFtIn(width)})`,
      `  Length: ${length} m (${mToFtIn(length)})`,
      `  Height: ${height} m (${mToFtIn(height)})`,
      `  Floor area: ${(roomDimensions.floorArea ?? +(width * length).toFixed(1))} m²` +
        ` (${((roomDimensions.floorArea ?? width * length) * 10.764).toFixed(0)} sq ft)`,
      `  ⚠ All digest measurements already reflect these calibrated dimensions.`,
    );
  }

  // ── Calibration / Scale Status ────────────────────────────────────────────
  if (globalScale) {
    const axesUniform =
      Math.abs(globalScale.x - globalScale.y) < 0.001 &&
      Math.abs(globalScale.x - globalScale.z) < 0.001;
    const scaleStr = axesUniform
      ? `${globalScale.x.toFixed(4)}×`
      : `X:${globalScale.x.toFixed(4)} Y:${globalScale.y.toFixed(4)} Z:${globalScale.z.toFixed(4)}`;
    const lockStatus = lockedScale != null ? "LOCKED by user — immutable" : "auto-computed";

    lines.push(
      ``,
      `CALIBRATION STATUS:`,
      `  Global Scale : ${scaleStr} (${lockStatus})`,
    );

    if (lockedScale != null) {
      lines.push(
        `  ⚠ This scale has been manually verified and locked by the user.`,
        `  All measurements in the Spatial Digest already reflect this calibration.`,
        `  Do NOT suggest the room is larger or smaller than the digest indicates.`,
        `  Do NOT propose a different scale factor unless the user explicitly asks.`,
      );
    } else {
      lines.push(
        `  Scale is auto-computed — treat digest measurements as best-estimate values.`,
      );
    }
  }

  // ── Spatial Digest ────────────────────────────────────────────────────────
  if (spatialDigest) {
    lines.push(``, `SPATIAL DIGEST (pre-verified by the scan engine — use these values directly):`);

    // ── Raw JSON block — parse numeric fields (width/depth/gapMetres) from here ──
    // This is the authoritative machine-readable source. When answering any
    // measurement question, read the value from this JSON first.
    lines.push(
      ``,
      `  Raw digest JSON (authoritative numeric values — always cite these):`,
      `  \`\`\`json`,
      `  ${JSON.stringify(spatialDigest, null, 2).split("\n").join("\n  ")}`,
      `  \`\`\``,
    );

    // ── Human-readable summary (for response phrasing) ──────────────────────
    if (spatialDigest.inventory.length > 0) {
      lines.push(``, `  Room Inventory (Source: 3D Spatial Digest):`);
      for (const item of spatialDigest.inventory) {
        lines.push(`    • ${item.label}`);
      }
    }

    if (spatialDigest.objectGaps.length > 0) {
      lines.push(
        ``,
        `  Object Clearances — Source: 3D Spatial Digest (primary furniture only):`,
      );
      for (const g of spatialDigest.objectGaps) {
        const flag = g.gapMetres < 0
          ? ` ⚠ items are positioned very closely`
          : g.gapMetres < 0.45
            ? ` ⚠ tight`
            : "";
        lines.push(`    • ${g.label}${flag}`);
      }
    }

    if (spatialDigest.wallClearances.length > 0) {
      lines.push(``, `  Wall Availability — Source: 3D Spatial Digest:`);
      for (const w of spatialDigest.wallClearances) {
        lines.push(`    • ${w.label}`);
      }
    }

    if (spatialDigest.pathBlockages.length > 0) {
      lines.push(``, `  Doorway Paths — Source: 3D Spatial Digest:`);
      for (const p of spatialDigest.pathBlockages) {
        lines.push(`    • ${p.label}`);
      }
    }
  }

  lines.push(
    ``,
    `SPATIAL REASONING RULES:`,
    `1. USE DIGEST FIRST: All clearance questions should be answered from the Spatial Digest above.`,
    `   If a gap is listed, quote it directly — do not recalculate.`,
    `   When citing any measurement, append "(Source: 3D Spatial Digest)" to make clear`,
    `   the value comes from the scan engine, not a visual estimate.`,
    `2. HUMAN COMFORT BUFFERS (apply when advising on furniture placement):`,
    `     • Coffee table to sofa  : min 0.45 m (18″).`,
    `     • Main walkway          : min 0.9 m  (3′).`,
    `     • Side passage          : min 0.6 m  (2′).`,
    `     • Bed clearance         : min 0.75 m (2′6″) on at least one side.`,
    `3. SILENT CALCULATION POLICY: Do ALL arithmetic silently in the background.`,
    `   NEVER output raw numbers, subtraction strings, or equations.`,
    `   Deliver only the insight: "There is about 2.1 m here — enough for a loveseat."`,
    `4. MEASUREMENT AUTHORITY: All sizes come from the 3D scan engine — they are physical truth.`,
    `   If spatial data is available in the Spatial Digest, it is the ABSOLUTE GROUND TRUTH.`,
    `   NEVER guess, estimate, or substitute a "typical" value when digest data is present.`,
    `   NEVER add disclaimers like "standard X is usually Y".`,
    `5. CLOSE-PROXIMITY DETECTION:`,
    `   • If the digest shows a negative gap, say: "These items are positioned very closely —`,
    `     are they actually touching in real life? If not, a fresh measurement will clarify."`,
    `   • A walkway gap below 0.9 m means it is blocking the walkway — say so plainly.`,
    `   • If gap = 0, report: "These pieces are right up against each other."`,
    `6. Always give measurements in BOTH metres AND feet/inches. Format: "2.5 m (8′2″)".`,
    // ── Friendly Terminology ──────────────────────────────────────────────
    `7. FRIENDLY TERMINOLOGY — always use these substitutions:`,
    `   • "merged mesh" / "mesh overlap"  → "items are positioned very closely"`,
    `   • "Z-axis overlap"                → "blocking the walkway"`,
    `   • "X-axis"                        → "side-to-side"`,
    `   • "voxel" / "re-scan"            → "fresh measurement"`,
    `   • Never say "xRange", "zRange", or "mesh-merge" to the user.`,
    // ── Law of Occupancy ─────────────────────────────────────────────────
    `8. LAW OF OCCUPANCY — before suggesting new or larger furniture, check Wall Availability:`,
    `   • If the wall is listed as "at functional capacity", respond:`,
    `     "This wall is at functional capacity — adding anything here would make the space`,
    `     feel cramped and block circulation."`,
    `   • If space is available, state the maximum width that would fit comfortably`,
    `     (available space minus 0.3 m buffer), phrased as a friendly recommendation.`,
    // ── Walking Path Integrity ────────────────────────────────────────────
    `9. WALKING PATH INTEGRITY — Red Zone rule:`,
    `   • If a Doorway Path is listed as blocked, no new furniture may be suggested there.`,
    `   • If a suggestion would land in a blocked path, refuse it and offer an alternative:`,
    `     "That spot sits in the natural path from the [Door] — here's what could work instead: …"`,
    // ── Deference to Luis ─────────────────────────────────────────────────
    `10. HUMAN OVERRIDE — Deference to Luis:`,
    `   • If Luis says a measurement is wrong or a piece doesn't fit, immediately accept`,
    `     his statement as authoritative and adjust your reasoning accordingly.`,
    `   • Acknowledge explicitly: "You're right — with that correction, here's the revised picture: …"`,
    `   • NEVER argue with Luis's physical experience. The scan is a tool, not the final word.`,
    // ── Graceful Degradation ──────────────────────────────────────────────
    `11. GRACEFUL DEGRADATION — Best Effort when digest data is missing:`,
    `   • If the user asks about an object whose gap is not in objectGaps, use its`,
    `     map (x, z, w, d) from the Room Inventory to estimate the distance silently`,
    `     and give a confident, qualified answer — never refuse.`,
    `   • If an object is listed as "footprint pending", use Room Dimensions and the`,
    `     object's recorded position to give a directional estimate:`,
    `     "The detailed footprint for the [Object] hasn't been fully measured yet.`,
    `      Based on its position, my best estimate is [X]."`,
    `   • If the digest is entirely absent, use Room Dimensions + comfort buffer rules`,
    `     and preface with: "I'm working from room dimensions only for now —`,
    `      here's my best guidance until a scan is complete."`,
    // ── Rug vs Furniture Priority ─────────────────────────────────────────
    `12. PHYSICAL CONSTRAINT GUARDRAIL — dimension sanity check:`,
    `   • Any single object dimension (width, depth, height, doorway span, gap) reported`,
    `     as LARGER THAN 4 metres is almost certainly a scan artefact, not a real measurement.`,
    `   • If such a value appears in the digest JSON, CROSS-REFERENCE the inventory:`,
    `     — If the inventory shows a smaller, realistic value for that object, use the`,
    `       inventory value and silently discard the oversized reading.`,
    `     — If no corrective value exists, flag it to the user:`,
    `       "The scan recorded an unusually large dimension for the [object] — a fresh`,
    `        measurement will give a more reliable figure."`,
    `   • NEVER report a doorway, chair, or standard furniture piece as wider than 4 metres.`,
    `   • Room dimensions (width/length of the whole room) may legitimately exceed 4 m`,
    `     and should NOT be flagged.`,
    ``,
    `13. RUG vs FURNITURE PRIORITY:`,
    `   • A rug is a floor covering, NOT a physical obstruction.`,
    `   • When answering questions about walking space, fitting new furniture, or`,
    `     clearance between pieces, use ONLY the boundaries of solid primary-tier`,
    `     items (sofa, table, bed, wardrobe, etc.).`,
    `   • Ignore rug footprints entirely for clearance purposes.`,
    `   • If a rug overlaps with furniture in the scan, that is normal — the rug`,
    `     sits beneath the furniture. It does not reduce walkable clearance.`,
    // ── Floor Occupancy Percentage ────────────────────────────────────────
    `14. FLOOR OCCUPANCY PERCENTAGE:`,
    `   • If asked what percentage of the floor is occupied, calculate:`,
    `     sum of (w × d) for all primary-tier inventory items ÷ room floor area.`,
    `   • Use the Room Dimensions floor area for the denominator.`,
    `   • Do this silently and report only the result as a rounded percentage.`,
    `   • If primary-tier map data is missing for any object, do NOT invent a number.`,
    `     Instead say: "I can't calculate a precise percentage yet, but the room`,
    `     looks [mostly clear / moderately full / quite full] based on what I can see."`,
    `     (Choose the qualifier that best matches the inventory you do have.)`,
  );

  return lines.join("\n");
}

const chatSchema = {
  type: SchemaType.OBJECT,
  properties: {
    locationId: {
      type: SchemaType.STRING,
      description: `Must be one of: ${validIds.join(", ")}, current`,
    },
    message: {
      type: SchemaType.STRING,
      description: "Short welcoming message about the destination room",
    },
  },
  required: ["locationId", "message"] as string[],
};

// ─── Discover mode (vision object detection) ───────────────────────────────────

const zoneItemSchema = {
  type: SchemaType.OBJECT,
  properties: {
    id: {
      type: SchemaType.STRING,
      description: "Zone identifier slug, e.g. 'kitchen', 'living-room', 'bedroom'",
    },
    label: {
      type: SchemaType.STRING,
      description: "Human-readable zone name, e.g. 'Kitchen', 'Living Room'",
    },
    xMin: {
      type: SchemaType.NUMBER,
      description: "Left boundary of the zone in metres from room origin (0 = left wall)",
    },
    xMax: {
      type: SchemaType.NUMBER,
      description: "Right boundary of the zone in metres",
    },
    zMin: {
      type: SchemaType.NUMBER,
      description: "Near boundary of the zone in metres from room origin (0 = viewer-side wall)",
    },
    zMax: {
      type: SchemaType.NUMBER,
      description: "Far boundary of the zone in metres",
    },
  },
  required: ["id", "label", "xMin", "xMax", "zMin", "zMax"] as string[],
};

const discoverSchema = {
  type: SchemaType.OBJECT,
  properties: {
    objects: {
      type: SchemaType.ARRAY,
      description: "All visible furniture and objects with their pixel coordinates",
      items: {
        type: SchemaType.OBJECT,
        properties: {
          name: {
            type: SchemaType.STRING,
            description: "Short lowercase name, e.g. 'sofa', 'coffee table', 'tv'",
          },
          x: {
            type: SchemaType.NUMBER,
            description: "Horizontal center pixel of the object in the image",
          },
          y: {
            type: SchemaType.NUMBER,
            description: "Vertical center pixel of the object in the image",
          },
          confidence: {
            type: SchemaType.NUMBER,
            description: "How certain you are this identification is correct: 0.0 = not sure, 1.0 = certain",
          },
          xLeft: {
            type: SchemaType.NUMBER,
            description: "Pixel X of the LEFT-most visible edge of the object (0 if unknown)",
          },
          xRight: {
            type: SchemaType.NUMBER,
            description: "Pixel X of the RIGHT-most visible edge of the object (0 if unknown)",
          },
          yTop: {
            type: SchemaType.NUMBER,
            description: "Pixel Y of the TOP-most visible edge of the object (0 if unknown)",
          },
          yBottom: {
            type: SchemaType.NUMBER,
            description: "Pixel Y of the BOTTOM-most visible edge of the object (0 if unknown)",
          },
        },
        required: ["name", "x", "y", "confidence", "xLeft", "xRight", "yTop", "yBottom"] as string[],
      },
    },
    zones: {
      type: SchemaType.ARRAY,
      description:
        "Architectural zone map. REQUIRED — omitting this field invalidates the scan. " +
        "Each zone covers a rectangular floor area in real-world metres. " +
        "Adjacent zones MUST share an exact boundary (Kitchen.zMax === LivingRoom.zMin). " +
        "Zones must collectively cover the entire room floor.",
      items: zoneItemSchema,
    },
    isPreCalibrated: {
      type: SchemaType.BOOLEAN,
      description: "Set to true when anchor room dimensions are provided and used as the scale reference",
    },
  },
  required: ["objects", "zones"] as string[],
};

/**
 * Builds the Spatial Engineer system prompt injected into the discover pass
 * when the user has supplied anchor room dimensions before the scan.
 */
function buildSpatialEngineerContext(
  anchorRoomType: string,
  anchorWidth:    number,
  masterCeiling:  number,
  anchorLength?:  number,
): string {
  const hasLength = anchorLength != null && anchorLength > 0;
  const zMax      = hasLength ? anchorLength! : null;
  // Suggest a split point at the midpoint when no visible floor transition is apparent.
  const zSplit    = zMax != null ? +(zMax / 2).toFixed(2) : null;

  const xBound = `X: 0–${anchorWidth}m`;
  const zBound = zMax != null ? `, Z: 0–${zMax}m` : "";

  return [
    `CONTEXT: You are a Spatial Engineer performing pre-calibrated object detection.`,
    ``,
    `GROUND TRUTH (user tape-measured — treat as absolute):`,
    `  • The ${anchorRoomType} is exactly ${anchorWidth}m wide.`,
    `  • The ceiling height is ${masterCeiling}m.`,
    ...(hasLength ? [`  • The room is ${zMax}m long (depth, Z-axis).`] : []),
    ``,
    `TASK:`,
    `  1. Locate the ${anchorRoomType} in the image(s).`,
    `  2. Use ${anchorWidth}m as the absolute ruler for the ${anchorRoomType} zone.`,
    `  3. Proportionally estimate all other visible zones (Kitchen, Dining, Hallway, Bedroom)`,
    `     relative to this anchor — do NOT guess; derive from the anchor width.`,
    `  4. Mark zone boundaries at visible floor transitions, material changes, or level changes.`,
    `  5. Set "isPreCalibrated": true in the output JSON to confirm anchor calibration was applied.`,
    ``,
    `ZONE OUTPUT (required field "zones" in output JSON):`,
    `  Divide the floor into semantic zones. Each zone: { id, label, xMin, xMax, zMin, zMax } in metres.`,
    `  Room origin (0, 0) is the near-left corner. X grows rightward. Z grows away from the viewer.`,
    ``,
    `  ADJACENCY RULE — adjacent zones MUST share an exact boundary line:`,
    `    Kitchen.zMax MUST equal LivingRoom.zMin. No gap. No overlap.`,
    ``,
    `  COMPLETENESS RULE — zones must cover the entire room floor:`,
    ...(hasLength
      ? [
          `    Collectively, zones must span X: 0–${anchorWidth}m and Z: 0–${zMax}m.`,
          ...(zSplit != null
            ? [`    If no visible floor transition is apparent, split at Z=${zSplit}m.`]
            : []),
        ]
      : [`    Zones must span the full X-width from 0 to ${anchorWidth}m.`]),
    ``,
    `  EXAMPLE (for a ${anchorWidth}m × ${zMax ?? "N"}m room):`,
    `    { "id": "kitchen",     "label": "Kitchen",     "xMin": 0, "xMax": ${anchorWidth}, "zMin": 0,       "zMax": ${zSplit ?? "??"} }`,
    `    { "id": "living-room", "label": "Living Room", "xMin": 0, "xMax": ${anchorWidth}, "zMin": ${zSplit ?? "??"}, "zMax": ${zMax ?? "??"} }`,
    ``,
    `COORDINATE CLAMPING — no object centroid may be placed outside the room boundary:`,
    `  ${xBound}${zBound}. Any object whose inferred world position exceeds these bounds`,
    `  must be pulled back to the nearest zone boundary before inclusion in "objects".`,
    ``,
    `SCALE RULE: Every object dimension you report must be consistent with the`,
    `${anchorRoomType} being ${anchorWidth}m wide. If an object appears wider than the`,
    `anchor room, it is a scan error — reduce confidence to 0.8 and report it anyway.`,
  ].join("\n");
}

// ─── Zone fallback builder ─────────────────────────────────────────────────────

/**
 * Generates a minimal zone array when Gemini omits the "zones" field.
 * Produces one or two zones depending on available anchor dimensions:
 *   • With width + length: splits along the Z midpoint into two named zones.
 *   • With width only:     creates a single full-width zone.
 *   • With neither:        creates a generic 5×5m placeholder zone.
 */
function buildFallbackZones(
  anchorRoomType: string | null,
  anchorWidth:    number | null,
  anchorLength:   number | null,
): Array<{ id: string; label: string; xMin: number; xMax: number; zMin: number; zMax: number }> {
  const w = anchorWidth  ?? 5.0;
  const l = anchorLength ?? 5.0;
  const label = anchorRoomType ?? "Room";
  const id    = label.toLowerCase().replace(/\s+/g, "-");

  if (anchorLength != null) {
    // Split Z at midpoint into two zones
    const mid = +(l / 2).toFixed(2);
    return [
      { id, label, xMin: 0, xMax: w, zMin: 0, zMax: mid },
      { id: "secondary-zone", label: "Secondary Zone", xMin: 0, xMax: w, zMin: mid, zMax: l },
    ];
  }

  return [{ id, label, xMin: 0, xMax: w, zMin: 0, zMax: l }];
}

// ─── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { mode } = body;

    if (mode === "discover") {
      return handleDiscover(body);
    }
    return handleChat(body);
  } catch (error: any) {
    console.error("[/api/chat] unhandled error:", error);

    if (error.status === 429) {
      return NextResponse.json(
        { error: "AI quota reached. Please wait a moment and try again." },
        { status: 429 }
      );
    }

    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// ─── Chat handler ──────────────────────────────────────────────────────────────

async function handleChat(body: {
  userMessage?:     string;
  roomDimensions?:  RoomDimensions | null;
  spatialDigest?:   SpatialDigest | null;
  currentRoomName?: string | null;
  spatialMode?:     SpatialMode | null;
  globalScale?:     { x: number; y: number; z: number } | null;
  lockedScale?:     number | null;
}) {
  const {
    userMessage,
    roomDimensions  = null,
    spatialDigest   = null,
    currentRoomName = null,
    spatialMode     = "room",
    globalScale     = null,
    lockedScale     = null,
  } = body;

  if (!userMessage) {
    return NextResponse.json({ error: "No message provided" }, { status: 400 });
  }

  const systemInstruction = buildChatInstruction(
    roomDimensions, spatialDigest, currentRoomName, spatialMode ?? "room",
    globalScale, lockedScale,
  );

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: chatSchema as any,
    },
  });

  const result = await model.generateContent(userMessage);
  const responseText = result.response.text();

  let parsed: { locationId: string; message: string };
  try {
    parsed = JSON.parse(responseText);
  } catch {
    console.error("[AeroPilot] JSON parse failed:", responseText);
    return NextResponse.json({ error: "AI returned malformed response" }, { status: 500 });
  }

  const normalisedId = (parsed.locationId ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "");

  const resolvedId =
    normalisedId === "current" ? "current"
    : validIds.includes(normalisedId) ? normalisedId
    : "living-room";

  console.log(
    `[AeroPilot API] raw="${parsed.locationId}" normalised="${normalisedId}" resolved="${resolvedId}"`
  );

  return NextResponse.json({ locationId: resolvedId, message: parsed.message });
}

// ─── Discover handler ──────────────────────────────────────────────────────────

async function handleDiscover(body: {
  image?: string;
  mimeType?: string;
  canvasWidth?: number;
  canvasHeight?: number;
  anchorRoomType?: string | null;
  anchorWidth?: number | null;
  anchorLength?: number | null;
  masterCeiling?: number | null;
  /** Set when re-examining an image after an implausible scale computation. */
  refinementContext?: {
    anchorObjA:  string;
    anchorObjB:  string;
    scaleFactor: number;
    anchorWidth: number;
  } | null;
  walkthroughMode?: boolean;
  perimeterTourMode?: boolean;
}) {
  const {
    image, mimeType = "image/jpeg", canvasWidth = 800, canvasHeight = 600,
    anchorRoomType = null, anchorWidth = null, anchorLength = null, masterCeiling = null,
    refinementContext = null, walkthroughMode = false, perimeterTourMode = false,
  } = body;

  if (!image) {
    return NextResponse.json({ error: "No image provided" }, { status: 400 });
  }

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: discoverSchema as any,
    },
  });

  const floorThreshold   = Math.round(canvasHeight * 0.60);
  const ceilingThreshold = Math.round(canvasHeight * 0.35);

  const hasAnchor = anchorRoomType != null && anchorWidth != null && masterCeiling != null;

  const prompt = [
    // ── Autonomous Surveyor Protocol — always active for all scan modes ─────────
    `AUTONOMOUS SURVEYOR PROTOCOL:`,
    `You are not a passive camera. You are an autonomous spatial surveyor standing in the center of the space.`,
    `Your task: mentally navigate to every sub-zone you can identify in the image(s).`,
    ``,
    `CRITICAL DISTANCE RULE — THRESHOLD-RELATIVE COORDINATES:`,
    `  Do NOT calculate distances from your physical standing position (your feet / camera origin).`,
    `  Instead, measure ALL dimensions from the THRESHOLD of each sub-zone:`,
    `  • Living Room threshold = the boundary line where you would step INTO the living area.`,
    `  • Kitchen threshold     = the visible dividing line between kitchen and adjacent zone.`,
    `  • Bedroom threshold     = the doorway opening you would walk through to enter.`,
    `  • Zone depth            = distance from that threshold to the far wall of the zone.`,
    `  • Object position       = (metres from threshold, metres from the nearer side wall).`,
    ``,
    `VIRTUAL NAVIGATION — for each zone you identify:`,
    `  1. Locate the zone's entry threshold in the image.`,
    `  2. Virtually "walk" from your position to that threshold.`,
    `  3. From the threshold, estimate the zone's depth and width.`,
    `  4. Place objects using threshold-relative coordinates (not camera-relative).`,
    ``,
    // ── Walk-through / virtual-waypoint context ──────────────────────────────
    ...(walkthroughMode
      ? [
          `VIRTUAL WAYPOINT CONTEXT: This image is a ZOOMED crop centred on a detected threshold.`,
          `  • Focus entirely on the architectural boundary visible here.`,
          `  • Identify the exact Exit Point of the near zone and the Entry Point of the far zone.`,
          `  • Use object scale changes across the boundary to verify depth: objects that appear ` +
          `smaller on the far side are proportionally further away — use the pixel-density ratio ` +
          `to calibrate the far zone's dimensions relative to the anchor room.`,
          `  • Return precise zone boundaries at this threshold, not a full-room zone map.`,
          ``,
        ]
      : []
    ),
    // ── Perimeter tour mode — human-centric room-by-room capture ─────────────
    ...(perimeterTourMode
      ? [
          `ROOM-BY-ROOM TOUR MODE:`,
          `You are receiving a complete tour of a space, room by room.`,
          `Each set of 4 images was captured from the CENTRE of a specific room.`,
          ``,
          `Use this clear 360° human-eye perspective to:`,
          `  • Provide exact wall-to-wall measurements for THIS room only.`,
          `  • Do NOT cross-contaminate zone dimensions — each room's footprint ends at its walls.`,
          `  • Place all objects relative to THIS room's walls, not the global origin.`,
          `  • The camera is at the room's geometric centre — distances to each wall are equal ` +
          `in all 4 cardinal directions (within ±20% for non-square rooms).`,
          `  • Use the 4-angle coverage to resolve occlusions and confirm object positions.`,
          ``,
        ]
      : []
    ),
    // ── Refinement context — injected first so it governs all decisions ────────
    ...(refinementContext != null
      ? [
          `REFINEMENT PASS: The previous spatial analysis produced an implausible scale factor ` +
          `(${refinementContext.scaleFactor.toFixed(2)}×). ` +
          `A factor this far from 1.0× means the measured distance between ` +
          `"${refinementContext.anchorObjA}" and "${refinementContext.anchorObjB}" was ` +
          `inconsistent with the tape-measured anchor width of ${refinementContext.anchorWidth}m.`,
          ``,
          `Re-examine the image carefully and focus on:`,
          `  1. The exact floor positions of "${refinementContext.anchorObjA}" and "${refinementContext.anchorObjB}".`,
          `  2. Their true physical separation relative to the ${refinementContext.anchorWidth}m anchor width.`,
          `  3. Verify zone boundaries — ensure no zone extends beyond the known room size.`,
          `Output corrected object positions and zone boundaries. Prioritise accuracy over completeness.`,
          ``,
        ]
      : []
    ),
    ...(hasAnchor
      ? [buildSpatialEngineerContext(anchorRoomType!, anchorWidth!, masterCeiling!, anchorLength ?? undefined), ``]
      : []
    ),
    `Object-detection for a 3D property scan. Image: ${canvasWidth}×${canvasHeight}px.`,
    ``,
    `TASK: ID every visible furniture/fixture. Short lowercase names ("sofa", "coffee table", "tv").`,
    `Only include objects with confidence ≥ 0.8.`,
    ``,
    `COORDINATES (integers only, no normalised/percentage values):`,
    `  x: pixels from LEFT (0–${canvasWidth})  y: pixels from TOP (0–${canvasHeight})`,
    `  Place x,y at the object's visible center.`,
    `  xLeft/xRight = outermost visible X edges; yTop/yBottom = outermost visible Y edges. Use 0 if unknown.`,
    ``,
    `CLASSIFICATION HINTS:`,
    `  y > ${floorThreshold} → floor-level (sofa, chair, table, cabinet, door)`,
    `  y < ${ceilingThreshold} → top-of-frame (window, wall lamp, ceiling light, high shelf)`,
    `  Wall opening: door if y > ${floorThreshold}, window if y < ${ceilingThreshold}.`,
    `  Prefer specific names: "dining table" over "table" when chairs are present.`,
    ``,
    `CONFIDENCE: 1.0 = certain; 0.8–0.95 = partial occlusion/ambiguity; < 0.8 = omit.`,
    ``,
    `ZONE MAP — field "zones" — REQUIRED in every response:`,
    `  TASK: Analyze the floor plane across all scan images. Identify EVERY distinct functional area.`,
    `  Examples: Kitchen, Living Room, Dining Room, Hallway, Entry, Office Corner, Bedroom.`,
    ``,
    `  ZONE LOGIC — Functional Schema:`,
    `    • A zone is defined by its SEMANTIC PURPOSE, not its physical size.`,
    `    • If a kitchen is 2 meters or 10 meters wide, it is ONE zone until the furniture TYPE changes.`,
    `    • A zone ends and a new one begins when the dominant furniture/appliance class transitions.`,
    `      Examples of transitions:`,
    `        appliances (fridge, stove, sink) → seating (sofa, tv)  = Kitchen → Living Room boundary`,
    `        seating (sofa, armchair) → sleeping (bed, nightstand)  = Living Room → Bedroom boundary`,
    `        any zone → narrow pass (< 1.5m wide)                   = Hallway / Entry boundary`,
    `    • Use floor material changes, appliance groupings, or furniture class changes as zone markers.`,
    `    • For every distinct area you identify, you MUST create a Zone entry in "zones".`,
    `    • There is NO limit to the number of zones — use as many as the space demands.`,
    `    • Use lowercase hyphenated ids: "kitchen", "living-room", "dining-room", "hallway", "entry".`,
    ``,
    `  BOUNDARY MATH:`,
    `    • Zones must be adjacent — the boundary of Zone A must align exactly with the start of Zone B.`,
    `    • Use floor material transitions, furniture type gaps, or level changes as split markers.`,
    `    • ZoneA.zMax MUST equal ZoneB.zMin for Z-adjacent zones (no gap, no overlap).`,
    `    • ZoneA.xMax MUST equal ZoneB.xMin for X-adjacent zones.`,
    ``,
    `  EXAMPLE — 5.0m × 5.5m open-plan with three functional areas:`,
    `    { "id": "kitchen",      "label": "Kitchen",      "xMin": 0, "xMax": 5.0, "zMin": 0,    "zMax": 1.83 }`,
    `    { "id": "dining-room",  "label": "Dining Room",  "xMin": 0, "xMax": 5.0, "zMin": 1.83, "zMax": 3.0  }`,
    `    { "id": "living-room",  "label": "Living Room",  "xMin": 0, "xMax": 5.0, "zMin": 3.0,  "zMax": 5.5  }`,
    `    ✓ kitchen.zMax(1.83) = dining.zMin(1.83)   ✓ dining.zMax(3.0) = living.zMin(3.0)`,
    ``,
    `  COMPLETENESS: Zones must collectively cover the entire visible floor — no unclaimed area.`,
    ...(anchorWidth != null && anchorLength != null
      ? [
          ``,
          `  COORDINATE LIMITS: The full scan MUST fit within ${anchorWidth}m × ${anchorLength}m.`,
          `    • No object centroid may be placed outside X: 0–${anchorWidth}m or Z: 0–${anchorLength}m.`,
          `    • No zone boundary may exceed these limits.`,
          `    • Example violation: a painting at Z=${(anchorLength * 1.14).toFixed(2)} when the room ends at Z=${anchorLength} is invalid.`,
        ]
      : anchorWidth != null
      ? [
          ``,
          `  COORDINATE LIMITS: The room is ${anchorWidth}m wide. No object or zone may exceed X=${anchorWidth}m.`,
        ]
      : []),
    ``,
    `  PRE-CALIBRATION: You MUST include "isPreCalibrated": true in the root of the JSON` +
      (hasAnchor ? ` (anchor dimensions have been provided — this is mandatory).` : `.`),
  ].join("\n");

  const result = await model.generateContent({
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { data: image, mimeType } },
          { text: prompt },
        ],
      },
    ],
  });

  const responseText = result.response.text();

  // Always log the raw Gemini payload — this lets us verify whether coords
  // are in the correct pixel space or have been normalised/scaled by Gemini.
  console.log(`[AeroPilot Vision] raw response (canvas ${canvasWidth}×${canvasHeight}):`, responseText);

  type RawZone = { id: string; label: string; xMin: number; xMax: number; zMin: number; zMax: number };
  type RawObj  = { name: string; x: number; y: number; confidence: number; xLeft?: number; xRight?: number; yTop?: number; yBottom?: number };
  let parsed: { objects: Array<RawObj>; zones?: Array<RawZone>; isPreCalibrated?: boolean };
  try {
    parsed = JSON.parse(responseText);
  } catch {
    console.error("[AeroPilot Vision] JSON parse failed:", responseText);
    return NextResponse.json({ error: "Vision AI returned malformed response" }, { status: 500 });
  }

  // ── Spatial Fragmentation Guard — fallback instead of hard failure ───────────
  // When zones are absent, generate a synthetic zone from anchor dimensions so
  // the rest of the spatial pipeline can still run. A hard 422 would discard all
  // successfully detected objects; the fallback preserves them.
  let zones: RawZone[];
  if (!parsed.zones || parsed.zones.length === 0) {
    console.error(
      `[Spatial Fragmentation] Vision model returned no zone boundaries for this pass. ` +
      `Generating server-side fallback zone. Raw tail: ${responseText.slice(0, 300)}`
    );
    zones = buildFallbackZones(anchorRoomType, anchorWidth, anchorLength);
    console.warn(
      `[Spatial Fragmentation] Fallback zone(s) created: ` +
      zones.map((z) => `${z.label}[X:${z.xMin}–${z.xMax}, Z:${z.zMin}–${z.zMax}]`).join(" | ")
    );
  } else {
    zones = parsed.zones;
  }

  // ── Zone diagnostic log ────────────────────────────────────────────────────
  console.log(
    `[AeroPilot Vision] Zone map (${zones.length} zone(s)):`,
    zones.map((z) =>
      `[${z.label}: X ${z.xMin.toFixed(2)}–${z.xMax.toFixed(2)}m, ` +
      `Z ${z.zMin.toFixed(2)}–${z.zMax.toFixed(2)}m ` +
      `(${((z.xMax - z.xMin) * (z.zMax - z.zMin)).toFixed(1)}m²)]`
    ).join("  |  ")
  );

  // When anchor values were supplied, treat the scan as pre-calibrated even if
  // Gemini omitted the flag (schema may not always honour optional booleans).
  const isPreCalibrated = parsed.isPreCalibrated === true || hasAnchor;

  // Sanity-check: warn if any coordinate looks suspiciously small (likely
  // normalised 0–1 or percentage 0–100 instead of absolute pixels).
  const allCoords = (parsed.objects ?? []).flatMap((o) => [o.x, o.y]);
  const maxCoord  = Math.max(...allCoords, 0);

  function scaleXY(o: RawObj, sx: number, sy: number): RawObj {
    return {
      ...o,
      x:      Math.round(o.x      * sx),
      y:      Math.round(o.y      * sy),
      xLeft:  o.xLeft  ? Math.round(o.xLeft  * sx) : 0,
      xRight: o.xRight ? Math.round(o.xRight * sx) : 0,
      yTop:   o.yTop   ? Math.round(o.yTop   * sy) : 0,
      yBottom:o.yBottom? Math.round(o.yBottom* sy) : 0,
    };
  }

  if (maxCoord < 2 && allCoords.length > 0) {
    console.warn(`[AeroPilot Vision] ⚠ normalised (0–1) coords detected — scaling up.`);
    parsed.objects = (parsed.objects ?? []).map((o) => scaleXY(o, canvasWidth, canvasHeight));
  } else if (maxCoord < 101 && allCoords.length > 0) {
    console.warn(`[AeroPilot Vision] ⚠ percentage coords detected — scaling up.`);
    parsed.objects = (parsed.objects ?? []).map((o) => scaleXY(o, canvasWidth / 100, canvasHeight / 100));
  }

  // Clamp all coordinates; pass confidence and edges through.
  const clampX = (v: number) => Math.max(0, Math.min(canvasWidth,  Math.round(v)));
  const clampY = (v: number) => Math.max(0, Math.min(canvasHeight, Math.round(v)));

  const clamped = (parsed.objects ?? []).map((o) => ({
    name:       o.name,
    x:          clampX(o.x),
    y:          clampY(o.y),
    confidence: Math.max(0, Math.min(1, o.confidence ?? 1)),
    xLeft:      o.xLeft  ? clampX(o.xLeft)  : undefined,
    xRight:     o.xRight ? clampX(o.xRight) : undefined,
    yTop:       o.yTop   ? clampY(o.yTop)   : undefined,
    yBottom:    o.yBottom? clampY(o.yBottom): undefined,
  }));

  console.log(
    `[AeroPilot Vision] resolved ${clamped.length} object(s):`,
    clamped.map((o) =>
      `${o.name}(${o.x},${o.y}) conf=${o.confidence.toFixed(2)}` +
      (o.xLeft !== undefined ? ` edges[${o.xLeft}–${o.xRight}]` : "")
    ).join(" | ")
  );

  if (hasAnchor) {
    console.log(
      `[AeroPilot Vision] Pre-calibrated scan — anchor: "${anchorRoomType}" ${anchorWidth}m wide` +
      `${anchorLength != null ? ` × ${anchorLength}m long` : ""}, ` +
      `ceiling ${masterCeiling}m. isPreCalibrated=${isPreCalibrated}`,
    );
  }

  return NextResponse.json({ objects: clamped, zones, isPreCalibrated });
}
