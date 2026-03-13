<div align="center">
  <h1 style="border-bottom: none;">🛸 AeroPilot</h1>
  <p><b>High-Fidelity AI Spatial Intelligence & Volumetric Mapping Engine</b></p>

  <img src="https://img.shields.io/badge/Next.js-15-black?style=for-the-badge&logo=next.js" />
  <img src="https://img.shields.io/badge/Three.js-3D_Geometry-blue?style=for-the-badge&logo=three.js" />
  <img src="https://img.shields.io/badge/Gemini_2.0-AI_Vision-orange?style=for-the-badge&logo=google-gemini" />
  <img src="https://img.shields.io/badge/Playwright-E2E_Testing-green?style=for-the-badge&logo=playwright" />

  <br />
  <br />

  <p align="center">
    AeroPilot bridges the gap between <b>Multimodal AI Vision</b> and <b>3D Spatial Calculus</b>. 
    It provides automated, volumetric measurements for interior surveying by converting 2D pixel coordinates 
    into precise 3D voxel clusters.
  </p>
</div>

---

## 🚀 Core Engine Capabilities

<table width="100%">
  <tr>
    <td width="50%" valign="top">
      <h3>🌍 Dynamic Enclosure Discovery</h3>
      Zero hard-coding. AeroPilot performs <b>6-Axis Raycasting</b> on initialization to detect the "Ground Truth" of any 3D environment (Ceiling Height, Wall Boundaries, and Total Volume).
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
</table>

---

## 🧪 Geometric Integrity & TDD

AeroPilot is built with a **Test-Driven Spatial Development** philosophy. Our E2E Playwright suite runs "Blind Volume Tests" to verify the physics of the engine:

- **Mass Stability:** Objects measured from multiple angles return consistent dimensions (within 2% variance).
- **Enclosure Safety:** No furniture measurement can exceed the dynamically discovered room boundaries.
- **Structural Awareness:** Employs _Neck Detection_ and _Plate Trimming_ to distinguish between floating furniture and fixed structural surfaces.

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
      <pre>GOOGLE_GENERATIVE_AI_API_KEY=your_key</pre>
    </td>
    <td valign="top">
      <p>1. <b>Run Full Geometry Suite</b></p>
      <code>npm test</code>
      <br /><br />
      <p>2. <b>Interactive Debugger (UI)</b></p>
      <code>npm run test:ui</code>
      <br /><br />
      <i>The suite verifies 3D mass stability and ensures no "room-bleeding" occurs during voxel growth.</i>
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
- **AI Vision:** Gemini 2.0 Flash (Multimodal)
- **Spatial Logic:** Custom Voxel BFS, Raycasting, Surface Normal Calculus
- **Persistence:** Zustand (AeroStore) with LocalStorage checkpointing
- **Optimization:** Asynchronous Batching (Parallel Promise Queue)
</details>

---

<div align="center">
  <p><b>Developed by Luis Gaviria</b><br />Web & Software Developer</p>
</div>
