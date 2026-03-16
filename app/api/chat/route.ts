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
  },
  required: ["objects"] as string[],
};

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
}) {
  const { image, mimeType = "image/jpeg", canvasWidth = 800, canvasHeight = 600 } = body;

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

  const prompt = [
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

  type RawObj = { name: string; x: number; y: number; confidence: number; xLeft?: number; xRight?: number; yTop?: number; yBottom?: number };
  let parsed: { objects: Array<RawObj> };
  try {
    parsed = JSON.parse(responseText);
  } catch {
    console.error("[AeroPilot Vision] JSON parse failed:", responseText);
    return NextResponse.json({ error: "Vision AI returned malformed response" }, { status: 500 });
  }

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

  return NextResponse.json({ objects: clamped });
}
