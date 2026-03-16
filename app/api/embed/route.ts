import { NextRequest, NextResponse } from "next/server";

const EMBED_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent` +
  `?key=${process.env.GEMINI_API_KEY}`;

/**
 * POST /api/embed
 * Body: { text: string }
 * Response: { embedding: number[] }
 *
 * Uses gemini-embedding-001 via the v1beta REST endpoint — a verified available
 * model on this API key. Returns 500 on failure; callers treat this as graceful
 * degradation and continue saving spatial data without the embedding.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { text } = body as { text?: string };

    if (!text || typeof text !== "string" || text.trim().length === 0) {
      return NextResponse.json({ error: "No text provided" }, { status: 400 });
    }

    const googleRes = await fetch(EMBED_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model:   "models/gemini-embedding-001",
        content: { parts: [{ text: text.trim() }] },
      }),
    });

    if (!googleRes.ok) {
      const errBody = await googleRes.text();
      console.error(`[Embed API] Google returned ${googleRes.status}:`, errBody);
      return NextResponse.json(
        { error: "Embedding failed", detail: errBody },
        { status: googleRes.status },
      );
    }

    const data = (await googleRes.json()) as {
      embedding?: { values?: number[] };
    };
    const values = data.embedding?.values;

    if (!Array.isArray(values) || values.length === 0) {
      console.error("[Embed API] Unexpected response shape:", data);
      return NextResponse.json({ error: "Unexpected embedding shape" }, { status: 500 });
    }

    console.log(
      `[Embed API] gemini-embedding-001 — ${values.length}-dim vector (${text.length} chars)`,
    );

    return NextResponse.json({ embedding: values });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[Embed API] Fetch threw:", msg);
    return NextResponse.json({ error: "Embedding failed", detail: msg }, { status: 500 });
  }
}
