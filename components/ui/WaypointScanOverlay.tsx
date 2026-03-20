"use client";

import { useAeroStore } from "@/store/useAeroStore";

export function WaypointScanOverlay() {
  const isDeepScanning   = useAeroStore((s) => s.isDeepScanning);
  const deepScanProgress = useAeroStore((s) => s.deepScanProgress);
  const deepScanTotal    = useAeroStore((s) => s.deepScanTotal);
  const surveyPhase      = useAeroStore((s) => s.surveyPhase);

  if (!isDeepScanning) return null;

  type Phase = { label: string; hint: string; icon: "spin" | "pulse" };
  let phase: Phase;

  if (surveyPhase === "virtual-waypoints") {
    phase = {
      label: "Navigating Thresholds",
      hint:  "Generating virtual waypoints at detected doorways and zone boundaries.",
      icon:  "spin",
    };
  } else if (surveyPhase === "resolving") {
    phase = {
      label: "Resolving Spatial Map",
      hint:  "All angles captured — fusing detections into a complete spatial model.",
      icon:  "pulse",
    };
  } else {
    phase = {
      label: `Capturing Frame ${deepScanProgress}/${deepScanTotal}`,
      hint:  "Autonomous 360° survey in progress. No action required.",
      icon:  "pulse",
    };
  }

  const framesComplete = surveyPhase !== null;

  return (
    <div className="pointer-events-none fixed top-4 right-4 z-[600] flex w-[20rem] flex-col gap-3 rounded-2xl border border-violet-500/30 bg-black/90 p-4 shadow-2xl shadow-black/60 backdrop-blur-md">

      {/* ── Header ── */}
      <div className="flex items-center gap-2">
        {phase.icon === "spin" ? (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5 shrink-0 animate-spin text-violet-400">
            <path fillRule="evenodd" d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.433a.75.75 0 000-1.5H3.989a.75.75 0 00-.75.75v4.242a.75.75 0 001.5 0v-2.43l.31.31a7 7 0 0011.712-3.138.75.75 0 00-1.449-.39zm1.23-3.723a.75.75 0 00.219-.53V2.929a.75.75 0 00-1.5 0V5.36l-.31-.31A7 7 0 003.239 8.188a.75.75 0 101.448.389A5.5 5.5 0 0113.89 6.11l.311.31h-2.432a.75.75 0 000 1.5h4.243a.75.75 0 00.53-.219z" clipRule="evenodd" />
          </svg>
        ) : (
          <span className="h-2 w-2 shrink-0 animate-ping rounded-full bg-violet-400" />
        )}
        <p className="text-[10px] font-semibold uppercase tracking-widest text-violet-400/80">
          Autonomous Surveyor
        </p>
      </div>

      {/* ── Current phase ── */}
      <div>
        <p className="text-sm font-semibold text-white">{phase.label}</p>
        <p className="mt-0.5 text-[10px] leading-snug text-white/45">{phase.hint}</p>
      </div>

      {/* ── Frame progress bar ── */}
      {deepScanTotal > 0 && (
        <div className="flex gap-0.5">
          {Array.from({ length: deepScanTotal }, (_, i) => (
            <div
              key={i}
              className={`h-1 flex-1 rounded-full transition-colors duration-300 ${
                framesComplete || i < deepScanProgress
                  ? "bg-violet-400"
                  : i === deepScanProgress && !framesComplete
                  ? "animate-pulse bg-violet-400/50"
                  : "bg-white/10"
              }`}
            />
          ))}
        </div>
      )}

      {/* ── Phase pipeline ── */}
      <div className="flex items-center gap-1.5 text-[9px] text-white/30">
        <span className={`rounded px-1.5 py-0.5 ${!surveyPhase ? "bg-violet-500/25 text-violet-300" : "text-white/20"}`}>
          360° Capture
        </span>
        <span className="text-white/15">→</span>
        <span className={`rounded px-1.5 py-0.5 ${surveyPhase === "resolving" ? "bg-violet-500/25 text-violet-300" : "text-white/20"}`}>
          AI Analysis
        </span>
        <span className="text-white/15">→</span>
        <span className={`rounded px-1.5 py-0.5 ${surveyPhase === "virtual-waypoints" ? "bg-violet-500/25 text-violet-300" : "text-white/20"}`}>
          Virtual Waypoints
        </span>
      </div>
    </div>
  );
}
