import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { NextRequest, NextResponse } from "next/server";
import { locations } from "@/data/locations";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

// ─── Shared helpers ────────────────────────────────────────────────────────────

const validIds = Object.keys(locations);

const locationContext = Object.values(locations)
  .map((loc) => `  "${loc.id}" — ${loc.label}`)
  .join("\n");

// ─── Chat mode (room navigation) ───────────────────────────────────────────────

interface RoomDimensions { width: number; length: number; height: number; floorArea?: number; }
interface DetectedObjectSummary {
  name: string;
  position3D: [number, number, number];
  confidence?: number;
  dimensions?: { width: number; height: number; depth: number };
}

function mToFtIn(m: number): string {
  const totalInches = m / 0.0254;
  const ft = Math.floor(totalInches / 12);
  const inches = Math.round(totalInches % 12);
  return `${ft}′${inches}″`;
}

function buildChatInstruction(
  roomDimensions: RoomDimensions | null,
  detectedObjects: DetectedObjectSummary[]
): string {
  const lines: string[] = [
    `You are AeroPilot, an AI guide for a 3D spatial property tour.`,
    `Your PRIMARY job is to navigate the user between rooms. You can ALSO answer spatial questions about the room.`,
    ``,
    `AVAILABLE LOCATION IDs (use EXACTLY as written):`,
    locationContext,
    ``,
    `NAVIGATION RULES:`,
    `1. You MUST always return a locationId. If the user is asking a spatial question (not navigating), return locationId "current".`,
    `2. locationId MUST be one of the IDs listed above, or "current". No other value is valid.`,
    `3. If navigating, message should be 1–2 sentences: welcoming and vivid.`,
    `4. If answering a spatial question, message should be concise and factual.`,
    `5. Do not add any keys beyond locationId and message.`,
  ];

  if (roomDimensions) {
    const { width, length, height } = roomDimensions;
    lines.push(
      ``,
      `ROOM DIMENSIONS (measured from the 3D model):`,
      `  Width:  ${width} m (${mToFtIn(width)})`,
      `  Length: ${length} m (${mToFtIn(length)})`,
      `  Height: ${height} m (${mToFtIn(height)})`,
      `  Floor area: ${(roomDimensions.floorArea ?? +(width * length).toFixed(1))} m² (${((roomDimensions.floorArea ?? width * length) * 10.764).toFixed(0)} sq ft)  [concave 2D projection — accounts for nooks and recesses]`,
    );
  }

  if (detectedObjects.length > 0) {
    lines.push(``, `DETECTED OBJECTS (3D world coordinates — X right, Y up, Z toward camera; Y=0 is floor):`);
    for (const obj of detectedObjects) {
      const [x, y, z] = obj.position3D;
      const conf = obj.confidence !== undefined ? ` conf=${Math.round(obj.confidence * 100)}%` : "";
      let dimStr = "";
      if (obj.dimensions) {
        const { width, height, depth } = obj.dimensions;
        dimStr = ` | size ${width}×${height}×${depth} m (W×H×D) = ${mToFtIn(width)} wide`;
      }
      lines.push(`  • ${obj.name}${conf} @ (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)})${dimStr}`);
    }
  }

  if (roomDimensions || detectedObjects.length > 0) {
    const halfW = roomDimensions ? (roomDimensions.width  / 2).toFixed(2) : "?";
    const halfL = roomDimensions ? (roomDimensions.length / 2).toFixed(2) : "?";
    lines.push(
      ``,
      `SPATIAL REASONING RULES:`,
      `1. Room walls (absolute GLB extents): X = ±${halfW} m (left/right), Z = ±${halfL} m (front/back).`,
      `2. Furniture fit: gap = (distance from object centre to nearest wall) − (object half-width).`,
      `   XZ-plane distance formula: √((x₂−x₁)²+(z₂−z₁)²).`,
      `3. "How big a couch can fit?" → longest gap between furniture and wall, minus 0.45 m legroom and 0.9 m walkway.`,
      `4. HUMAN COMFORT BUFFERS (always apply):`,
      `     • Coffee table to sofa: min 0.45 m (18″).`,
      `     • Main walkway: min 0.9 m (3′).`,
      `     • Side passage: min 0.6 m (2′).`,
      `     • Bed clearance: min 0.75 m (2′6″) on at least one side.`,
      `5. CLUSTER MEASUREMENT AUTHORITY:`,
      `   • ALL object sizes come from the 3D mesh-clustering engine. The "size W×H×D m" values`,
      `     above are computed directly from the GLB geometry — they are the physical truth.`,
      `   • NEVER estimate, guess, or adjust dimensions based on what "looks typical".`,
      `   • NEVER add disclaimers like "standard doors are usually X m" — report only the measured value.`,
      `   • If "size W×H×D" is absent for an object, say exactly:`,
      `     "I need a scan of that specific area to calculate the physical volume."`,
      `   • If a dimension is 0 m (cluster returned no vertices), say:`,
      `     "The clustering engine returned 0 for that axis — a re-scan of that corner is needed."`,
      `6. Always give measurements in BOTH metres AND feet/inches. Format: "2.5 m (8′2″)".`,
      `7. Keep spatial answers concise: state the key measurement, then 1 sentence of practical context.`,
    );
  }

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
  userMessage?: string;
  roomDimensions?: RoomDimensions | null;
  detectedObjects?: DetectedObjectSummary[];
}) {
  const { userMessage, roomDimensions = null, detectedObjects = [] } = body;

  if (!userMessage) {
    return NextResponse.json({ error: "No message provided" }, { status: 400 });
  }

  const systemInstruction = buildChatInstruction(roomDimensions, detectedObjects);

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
