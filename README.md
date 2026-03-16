<div align="center">
  <h1 style="border-bottom: none;">🛸 AeroPilot</h1>
  <p><b>High-Fidelity AI Spatial Intelligence & Volumetric Mapping Engine</b></p>

  <img src="https://img.shields.io/badge/Next.js-15-black?style=for-the-badge&logo=next.js" alt="Next.js" />
  <img src="https://img.shields.io/badge/Three.js-3D_Geometry-blue?style=for-the-badge&logo=three.js" alt="Three.js" />
  <img src="https://img.shields.io/badge/Gemini_2.0-AI_Vision-orange?style=for-the-badge&logo=google-gemini" alt="Gemini" />
  <img src="https://img.shields.io/badge/Supabase-pgvector-3ECF8E?style=for-the-badge&logo=supabase" alt="Supabase" />
  <img src="https://img.shields.io/badge/Playwright-E2E_Testing-green?style=for-the-badge&logo=playwright" alt="Playwright" />

  <br />
  <br />

  <p align="center">
    AeroPilot bridges the gap between <b>Multimodal AI Vision</b> and <b>3D Spatial Calculus</b>.
    It provides automated, volumetric measurements for interior surveying by converting 2D pixel coordinates
    into precise 3D voxel clusters — then grounds every measurement against human-centric architectural
    reality using a <b>Weighted Heuristic Scale Engine</b> and persistent longitudinal room memory.
  </p>
</div>

---

## 🚀 Core Engine Capabilities

<table width="100%">
  <tr>
    <td width="50%" valign="top">
      <h3>🌍 Dynamic Enclosure Discovery</h3>
       AeroPilot performs <b>6-Axis Raycasting</b> on initialization to detect the "Ground Truth" of any 3D environment (Ceiling Height, Wall Boundaries, and Total Volume).
    </td>
    <td width="50%" valign="top">
      <h3>📦 Adaptive Voxel Mapping</h3>
      A custom <b>Breadth-First Search (BFS) Engine</b> converts 2D vision data into 3D mass. This allows the system to understand true physical volume rather than simple bounding boxes.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>📐 Normal-Based Clipping</h3>
      Utilizes <b>Surface Normal Validation</b> (Anti-Bleed) to prevent furniture from merging into structural walls. If geometric growth hits a 90° boundary, the engine clips the measurement automatically.
    </td>
    <td width="50%" valign="top">
      <h3>⚡ Parallel Deep Scanning</h3>
      "Burst Mode" captures and processes 8 high-resolution snapshots concurrently. Uses asynchronous batching to build high-density point clouds with 60% less latency.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>🧠 Weighted Heuristic Scale Engine</h3>
      A <b>two-pass Semantic Scale system</b> eliminates hardcoded object sizes. Pass 1 matches all detected objects to a Standard Reference Library (classWeights: 1.0 High / 0.4 Medium / 0.1 Low). Pass 2 runs a <b>Bed Ladder</b> nearest-neighbour heuristic — comparing raw mesh width against four standard mattress sizes (Twin 0.9m → King 1.95m) and selecting the rung that requires the least room-wide scale deviation. High-trust furniture anchors (Beds, Sofas, Dining Tables) always outweigh architectural noise such as windows and doorways.
    </td>
    <td width="50%" valign="top">
      <h3>🏗️ Sanity Floor & Loft Mode</h3>
      After computing a candidate scale factor, the engine enforces <b>architectural plausibility</b>. A <i>Sanity Floor</i> guarantees the scaled ceiling never falls below 2.3 m — if breached, Override Factor A (target 2.4 m ceiling) and Override Factor B (ladder-selected bed width) are compared and the larger wins. For loft and double-height spaces, <i>Loft Mode</i> activates when the tentative ceiling exceeds 3.5 m: bed anchor weights are boosted ×1.5 so the Furniture Ladder drives the result instead of unreliable architectural averages. The Reality Filter ceiling cap is extended to 7.0 m to accommodate these spaces without triggering a false Heuristic Variance warning.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>🗄️ Longitudinal Room Memory</h3>
      Scan results are embedded into <b>3072-dimensional pgvector embeddings</b> and persisted in Supabase. Each room session stores a <i>Spatial Digest</i> — object positions, scaled dimensions, and the resolved scale factor — enabling longitudinal comparison across revisits. The end-to-end sync pipeline writes on scan completion and reads on load, so the AI can detect physical changes between sessions and surface drift alerts to the user.
    </td>
    <td width="50%" valign="top">
      <h3>🔧 Diagnostic Dashboard & Scale Control</h3>
      A built-in <b>Diagnostic Dashboard</b> exposes the full internals of each calibration pass: per-anchor confidence scores, weighted median, outlier rejections, loft detection status, and consensus lock state. Users can <b>manually override the scale factor</b> via a numeric input, which is immediately written to <code>localStorage</code> so the correction survives page reloads. A visual lock indicator distinguishes auto-computed, consensus-locked, and user-overridden scale states.
    </td>
  </tr>
</table>

---

## 🧪 Geometric Integrity & TDD

AeroPilot is built with a **Test-Driven Spatial Development** philosophy. Our E2E Playwright suite runs "Blind Volume Tests" to verify the physics of the engine:

- **Mass Stability:** Objects measured from multiple angles return consistent dimensions (within 2% variance).
- **Enclosure Safety:** No furniture measurement can exceed the dynamically discovered room boundaries.
- **Structural Awareness:** Employs _Neck Detection_ and _Plate Trimming_ to distinguish between floating furniture and fixed structural surfaces.
- **Scale Regression:** The Spatial Intelligence suite asserts that the Weighted Heuristic Engine selects the correct Bed Ladder rung and that consensus lock fires when Bed=Queen and Sofa length ≈ 2.1 m.

---

## 🛠️ Technical Setup & Deployment

<table width="100%">
  <tr>
    <th align="left" width="50%">💻 Installation & Environment</th>
    <th align="left" width="50%">🧪 Automated Testing Suite</th>
  </tr>
  <tr>
    <td valign="top">
      <p>1. <b>Install Dependencies</b></p>
      <code>npm install</code>
      <br /><br />
      <p>2. <b>API Configuration</b></p>
      Create a <code>.env</code> file in the root directory:
      <pre>GOOGLE_GENERATIVE_AI_API_KEY=your_key
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key</pre>
    </td>
    <td valign="top">
      <p>1. <b>Run Full Geometry Suite</b></p>
      <code>npm test</code>
      <br /><br />
      <p>2. <b>Interactive Debugger (UI)</b></p>
      <code>npm run test:ui</code>
      <br /><br />
      <i>The suite verifies 3D mass stability, ensures no "room-bleeding" occurs during voxel growth, and validates the Semantic Scale heuristic against known bed-size fixtures.</i>
    </td>
  </tr>
</table>

---

## ⚙️ Architecture Deep Dive

<details>
<summary><b>View Internal Data Flow & Stack</b></summary>
<br />

- **Frontend:** Next.js 15 (App Router), React, Tailwind CSS
- **3D Engine:** Three.js / React Three Fiber (R3F)
- **AI Vision:** Gemini 2.5 Flash (Multimodal) — object detection with per-label confidence scores
- **Spatial Logic:** Custom Voxel BFS, Raycasting, Surface Normal Calculus
- **Scale Calibration:** Weighted Heuristic Engine (`utils/semanticScale.ts`) — two-pass Bed Ladder, Loft Mode, Consensus Validation, Sanity Floor
- **Standard Reference Library:** `data/standardAnchors.ts` — classWeighted anchor patterns, `BED_LADDER` (Twin → King), `SOFA_STANDARD_LENGTH`
- **Persistence:** Zustand (AeroStore) with LocalStorage checkpointing; manual scale overrides persisted across reloads
- **Vector Database:** Supabase with `pgvector` extension — 3072-dim spatial embeddings for longitudinal room memory
- **Diagnostics:** In-app Diagnostic Dashboard — live anchor scores, outlier log, loft/consensus state, manual scale lock UI
- **Optimization:** Asynchronous Batching (Parallel Promise Queue)

**Scale Calibration Data Flow**

Gemini scan → DetectedObject[] (with rawDimensions + confidence)
→ Pass 1: match STANDARD_ANCHORS (first-match, classWeighted)
→ Pass 2: Bed Ladder nearest-neighbour (prelim consensus → best rung)
→ Weighted median → outlier rejection
→ Weighted average → initial factor
→ Loft Awareness (ceiling > 3.5m → boost bed ×1.5)
→ Reality Filter (ceiling ∈ [2.1m, 7.0m])
→ Consensus Validation (Bed=Queen ∧ Sofa≈2.1m → lock)
→ Sanity Floor (ceiling < 2.3m → override A/B)
→ ScaleResult { factor, matches[] }

**Persistence Data Flow**

Scan complete → SpatialDigest built (objects + factor + timestamp)
→ Embed via text-embedding-3-large (3072-dim)
→ Upsert to Supabase spatial_memories table
→ On next load: fetch nearest embedding → surface drift delta to user

</details>

---

<div align="center">
  <p><b>Developed by Luis Gaviria</b><br />Web & Software Developer</p>
</div>
