"use client";

import { useState } from "react";
import { useAeroStore } from "@/store/useAeroStore";
import { fmtLen } from "@/utils/units";

/**
 * Reference Ruler overlay — appears when exactly 2 ruler points have been placed.
 *
 * Displays:
 *  • The measured Three.js scene distance between the two points.
 *  • An input prompting for the real-world distance in metres.
 *
 * On submit: calls commitRulerRatio(threejsDist, realMetres) which persists the
 * metricRatio to localStorage and immediately re-scales all detected objects.
 */
export function RulerOverlay() {
  const rulerPoints      = useAeroStore((s) => s.rulerPoints);
  const rulerActive      = useAeroStore((s) => s.rulerActive);
  const commitRulerRatio = useAeroStore((s) => s.commitRulerRatio);
  const clearRuler       = useAeroStore((s) => s.clearRuler);

  const [input, setInput] = useState("");

  // Only show when ruler mode is active and exactly 2 points have been placed.
  if (!rulerActive || rulerPoints.length !== 2) return null;

  const [p1, p2] = rulerPoints;
  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  const dz = p2[2] - p1[2];
  const threejsDist = Math.sqrt(dx * dx + dy * dy + dz * dz);

  function commit() {
    const n = parseFloat(input);
    if (Number.isFinite(n) && n > 0) {
      commitRulerRatio(threejsDist, n);
      setInput("");
    }
  }

  return (
    <div className="pointer-events-auto absolute left-1/2 top-1/2 z-[300] -translate-x-1/2 -translate-y-1/2">
      <div className="flex w-[22rem] flex-col gap-3 rounded-2xl border border-cyan-400/30 bg-black/88 p-5 shadow-2xl shadow-black/70 backdrop-blur-md">

        {/* Header */}
        <div className="flex items-center justify-between">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-cyan-400/60">
            Reference Ruler
          </p>
          <button
            onClick={clearRuler}
            className="rounded px-2 py-1 text-[10px] text-white/30 transition-colors hover:bg-white/10 hover:text-white/60"
          >
            Cancel
          </button>
        </div>

        {/* Scene distance readout */}
        <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3">
          <p className="text-[9px] uppercase tracking-wider text-white/40">
            Three.js Scene Distance
          </p>
          <p className="mt-0.5 font-mono text-lg font-semibold text-cyan-300">
            {threejsDist.toFixed(4)} units
          </p>
        </div>

        {/* Real-distance input */}
        <div>
          <p className="mb-1.5 text-[11px] font-medium text-white/70">
            Real distance between these points?
          </p>
          <div className="flex items-center gap-2">
            <input
              autoFocus
              type="number"
              step="0.01"
              min="0.01"
              max="999"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") clearRuler(); }}
              placeholder="e.g. 3.66"
              className="flex-1 rounded-lg border border-white/20 bg-black/50 px-3 py-2 text-sm text-white outline-none placeholder-white/25 focus:border-cyan-400/60"
            />
            <span className="text-[11px] text-white/40">m</span>
            <button
              onClick={commit}
              disabled={!input.trim()}
              className="rounded-lg bg-cyan-500 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Set
            </button>
          </div>
          {input && (() => {
            const n = parseFloat(input);
            if (!Number.isFinite(n) || n <= 0) return null;
            const ratio = +(n / threejsDist).toFixed(4);
            return (
              <p className="mt-1.5 text-[9px] text-white/35">
                metricRatio = {ratio}× · scaled: {fmtLen(threejsDist * ratio)}
              </p>
            );
          })()}
        </div>

      </div>
    </div>
  );
}
