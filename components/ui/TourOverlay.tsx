"use client";

import { useEffect, useRef } from "react";
import { useAeroStore } from "@/store/useAeroStore";
import { TourStop } from "@/types/auto-discovery";

function certaintColor(score: number): string {
  if (score > 85) return "text-emerald-400";
  if (score >= 60) return "text-yellow-400";
  return "text-red-400";
}

/** Human-readable label for the current stop type. */
function stopCategory(stop: TourStop): string {
  if (stop.kind === "corner") return `Spatial Survey · Vantage ${stop.cornerIndex + 1}`;
  return stop.sweepPhase === "left" ? "Boundary Transition · Left" : "Boundary Transition · Right";
}

/** Narrative pushed to the chat panel when the camera settles. */
function buildNarrative(
  stop: TourStop,
  clearance: { totalArea: number; walkableArea: number; spatialCertainty: number } | null,
): string {
  if (stop.kind === "corner") {
    const area      = clearance?.totalArea.toFixed(1)     ?? "–";
    const walkable  = clearance?.walkableArea.toFixed(1)  ?? "–";
    const certainty = clearance?.spatialCertainty         ?? 0;
    return (
      `Spatial survey from vantage ${stop.cornerIndex + 1}. ` +
      `Total floor area: ${area} m². Walkable space: ${walkable} m². ` +
      `Spatial certainty: ${certainty}%.`
    );
  }
  return (
    `Spatial transition detected. ` +
    `Opening span: ${stop.openingWidth.toFixed(2)} m.`
  );
}

export function TourOverlay() {
  const isTouring        = useAeroStore((s) => s.isTouring);
  const isMoving         = useAeroStore((s) => s.isMoving);
  const tourIndex        = useAeroStore((s) => s.tourIndex);
  const tourStops        = useAeroStore((s) => s.tourStops);
  const spatialClearance = useAeroStore((s) => s.spatialClearance);
  const setAiMessage     = useAeroStore((s) => s.setAiMessage);
  const stopTour         = useAeroStore((s) => s.stopTour);
  const tourAdvance      = useAeroStore((s) => s.tourAdvance);

  const stop   = tourStops[tourIndex];
  const isLast = tourIndex === tourStops.length - 1;

  const settledRef     = useRef(false);
  const autoAdvanceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset settled guard whenever the tour moves to a new stop
  useEffect(() => {
    settledRef.current = false;
    if (autoAdvanceRef.current) {
      clearTimeout(autoAdvanceRef.current);
      autoAdvanceRef.current = null;
    }
  }, [tourIndex, isTouring]);

  // Once the camera settles, push narrative and schedule auto-advance
  useEffect(() => {
    if (!isTouring || isMoving || settledRef.current || !stop) return;
    settledRef.current = true;

    setAiMessage(buildNarrative(stop, spatialClearance));

    autoAdvanceRef.current = setTimeout(() => {
      tourAdvance();
    }, stop.durationMs);

    return () => {
      if (autoAdvanceRef.current) {
        clearTimeout(autoAdvanceRef.current);
        autoAdvanceRef.current = null;
      }
    };
  }, [isMoving, isTouring, tourIndex, stop, spatialClearance, setAiMessage, tourAdvance]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (autoAdvanceRef.current) clearTimeout(autoAdvanceRef.current);
    };
  }, []);

  if (!isTouring || !stop) return null;

  const sc = spatialClearance;

  const handleNext = () => {
    if (autoAdvanceRef.current) {
      clearTimeout(autoAdvanceRef.current);
      autoAdvanceRef.current = null;
    }
    tourAdvance();
  };

  const handleClose = () => {
    if (autoAdvanceRef.current) {
      clearTimeout(autoAdvanceRef.current);
      autoAdvanceRef.current = null;
    }
    stopTour();
  };

  return (
    <div className="pointer-events-auto absolute bottom-6 left-1/2 z-[200] -translate-x-1/2">
      <div className="flex w-[22rem] flex-col gap-3 rounded-2xl border border-white/15 bg-black/80 p-5 shadow-2xl shadow-black/60 backdrop-blur-md">

        {/* ── Header ── */}
        <div className="flex items-center justify-between">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-white/50">
            {stopCategory(stop)}
          </p>
          <button
            onClick={handleClose}
            className="rounded-md px-2 py-1 text-[10px] font-medium text-white/30 transition-colors hover:bg-white/10 hover:text-white/60"
          >
            Close
          </button>
        </div>

        {/* ── Title ── */}
        <p className="text-2xl font-bold tracking-tight text-white">
          {stop.kind === "corner" ? "Room Scan" : "Spatial Opening"}
        </p>

        {/* ── Stats ── */}
        {stop.kind === "corner" && sc && (
          <div className="grid grid-cols-3 gap-2">
            <div className="flex flex-col rounded-xl border border-white/10 bg-white/5 px-3 py-2">
              <span className="text-[9px] uppercase tracking-wider text-white/40">
                Floor Area
              </span>
              <span className="text-sm font-semibold text-white">
                {sc.totalArea.toFixed(1)} m²
              </span>
            </div>
            <div className="flex flex-col rounded-xl border border-white/10 bg-white/5 px-3 py-2">
              <span className="text-[9px] uppercase tracking-wider text-white/40">
                Walkable
              </span>
              <span className="text-sm font-semibold text-white">
                {sc.walkableArea.toFixed(1)} m²
              </span>
            </div>
            <div className="flex flex-col rounded-xl border border-white/10 bg-white/5 px-3 py-2">
              <span className="text-[9px] uppercase tracking-wider text-white/40">
                Certainty
              </span>
              <span className={`text-sm font-semibold ${certaintColor(sc.spatialCertainty)}`}>
                {sc.spatialCertainty}%
              </span>
            </div>
          </div>
        )}

        {stop.kind === "sweep" && (
          <div className="flex gap-2">
            <div className="flex flex-col rounded-xl border border-sky-400/20 bg-sky-500/10 px-3 py-2">
              <span className="text-[9px] uppercase tracking-wider text-sky-400/60">
                Opening Span
              </span>
              <span className="text-sm font-semibold text-sky-200">
                {stop.openingWidth.toFixed(2)} m
              </span>
            </div>
            <div className="flex flex-col rounded-xl border border-white/10 bg-white/5 px-3 py-2">
              <span className="text-[9px] uppercase tracking-wider text-white/40">
                Sweep
              </span>
              <span className="text-sm font-semibold capitalize text-white">
                {stop.sweepPhase}
              </span>
            </div>
          </div>
        )}

        {/* ── Progress dots + Next button ── */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            {tourStops.map((s, i) => (
              <div
                key={i}
                className={`h-1.5 rounded-full transition-all duration-300 ${
                  i === tourIndex
                    ? "w-4 bg-sky-400"
                    : i < tourIndex
                    ? "w-1.5 bg-white/40"
                    : "w-1.5 bg-white/15"
                } ${s.kind === "sweep" ? "rounded-none" : ""}`}
              />
            ))}
          </div>
          <button
            onClick={handleNext}
            disabled={isMoving}
            className="rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isLast ? "Finish" : "Next →"}
          </button>
        </div>

      </div>
    </div>
  );
}
