"use client";

import { useState, useRef, KeyboardEvent } from "react";
import { useAeroStore } from "@/store/useAeroStore";
import { AnchorMatch, ScaleVector3 } from "@/utils/semanticScale";
import { PreScanModal, type PreScanValues } from "@/components/ui/PreScanModal";

/** Tailwind color class for a volumeAccuracy score. */
function accuracyColor(score: number): string {
  if (score > 85) return "text-emerald-400";
  if (score >= 60) return "text-yellow-400";
  return "text-red-400";
}

/** Compact read-out of the Semantic Scale Calibration state. */
function ScaleIndicator({
  globalScale,
  verifiedScaleFactor,
  anchorLog,
  setVerifiedScaleFactor,
}: {
  globalScale: ScaleVector3 | null;
  verifiedScaleFactor: number | null;
  anchorLog: AnchorMatch[];
  setVerifiedScaleFactor: (v: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft,   setDraft]   = useState("");

  const includedAnchors = anchorLog.filter((m) => m.included);

  // Only show when there's actual calibration data.
  if (!globalScale || (anchorLog.length === 0 && verifiedScaleFactor == null)) return null;

  const isVerified  = verifiedScaleFactor != null;
  const label       = isVerified ? "Tape Measure" : "Auto-Calibrated";
  const color       = isVerified ? "text-amber-300" : "text-emerald-300";
  const borderColor = isVerified ? "border-amber-500/30" : "border-emerald-500/30";
  const bgColor     = isVerified ? "bg-amber-500/10"     : "bg-emerald-500/10";

  // Axes are uniform when all three values match within floating-point noise.
  const axesUniform = Math.abs(globalScale.x - globalScale.y) < 0.001 &&
                      Math.abs(globalScale.x - globalScale.z) < 0.001;
  // Displayed factor for the override input seed.
  const displayFactor = globalScale.x;

  function commitEdit() {
    const n = parseFloat(draft);
    if (Number.isFinite(n) && n > 0) setVerifiedScaleFactor(n);
    setEditing(false);
  }

  return (
    <div className={`flex items-center justify-between gap-2 rounded-lg border ${borderColor} ${bgColor} px-3 py-1.5 text-[10px]`}>
      <div className="flex items-center gap-2 min-w-0">
        {/* Ruler icon */}
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={`h-3 w-3 shrink-0 ${color}`}>
          <path fillRule="evenodd" d="M.99 5.24A2.25 2.25 0 013.25 3h13.5A2.25 2.25 0 0119 5.25l.01 9.5A2.25 2.25 0 0116.76 17H3.26A2.25 2.25 0 011 14.74l-.01-9.5zm8.26 9.52v-.001a.75.75 0 00.75.75h1.5a.75.75 0 00.75-.75v-4.5a.75.75 0 00-.75-.75h-1.5a.75.75 0 00-.75.75v4.5zm-3.5 0v.001a.75.75 0 00.75.75H8a.75.75 0 00.75-.75v-2.5A.75.75 0 008 11.5H6.5a.75.75 0 00-.75.75v2.5zm7 0v.001a.75.75 0 00.75.75h1.5a.75.75 0 00.75-.75v-2.5a.75.75 0 00-.75-.75H13.5a.75.75 0 00-.75.75v2.5z" clipRule="evenodd" />
        </svg>
        {axesUniform ? (
          <span className={`font-semibold ${color}`}>{displayFactor.toFixed(3)}×</span>
        ) : (
          <span className={`font-semibold ${color}`}>
            X:{globalScale.x.toFixed(3)} Y:{globalScale.y.toFixed(3)} Z:{globalScale.z.toFixed(3)}
          </span>
        )}
        <span className="text-white/40">{label}</span>
        {includedAnchors.length > 0 && (
          <span className="text-white/30">
            ({includedAnchors.length}/{anchorLog.length} anchors)
          </span>
        )}
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        {editing ? (
          <>
            <input
              autoFocus
              type="number"
              step="0.01"
              min="0.1"
              max="10"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEditing(false); }}
              placeholder={displayFactor.toFixed(3)}
              className="w-16 rounded border border-white/20 bg-black/40 px-1.5 py-0.5 text-[10px] text-white outline-none focus:border-amber-400/60"
            />
            <button onClick={commitEdit} className="text-emerald-400 hover:text-emerald-300 transition-colors text-[10px] font-medium">Set</button>
            <button onClick={() => setEditing(false)} className="text-white/30 hover:text-white/60 transition-colors text-[10px]">✕</button>
          </>
        ) : (
          <>
            <button
              onClick={() => { setDraft(displayFactor.toFixed(3)); setEditing(true); }}
              title="Enter tape-measure uniform override"
              className="rounded px-1.5 py-0.5 text-[10px] text-white/30 hover:bg-white/10 hover:text-white/60 transition-colors"
            >
              Override
            </button>
            {isVerified && (
              <button
                onClick={() => setVerifiedScaleFactor(null)}
                title="Clear manual override — revert to auto"
                className="rounded px-1.5 py-0.5 text-[10px] text-white/30 hover:bg-white/10 hover:text-white/60 transition-colors"
              >
                Auto
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function ChatInput() {
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // ── Pre-Scan Calibration modal state ──
  const [preScanModal, setPreScanModal] = useState<"quick" | "deep" | null>(null);

  const sendMessage     = useAeroStore((s) => s.sendMessage);
  const clearHistory    = useAeroStore((s) => s.clearHistory);
  const triggerScan     = useAeroStore((s) => s.triggerScan);
  const triggerDeepScan      = useAeroStore((s) => s.triggerDeepScan);
  const setPendingRoomSpec   = useAeroStore((s) => s.setPendingRoomSpec);
  const aiMessage       = useAeroStore((s) => s.aiMessage);
  const isThinking      = useAeroStore((s) => s.isThinking);
  const isMoving        = useAeroStore((s) => s.isMoving);
  const isScanning      = useAeroStore((s) => s.isScanning);
  const isDeepScanning  = useAeroStore((s) => s.isDeepScanning);
  const deepScanProgress = useAeroStore((s) => s.deepScanProgress);
  const deepScanTotal   = useAeroStore((s) => s.deepScanTotal);
  const detectedObjects = useAeroStore((s) => s.detectedObjects);
  const isTouring            = useAeroStore((s) => s.isTouring);
  const startTour            = useAeroStore((s) => s.startTour);
  const roomDimensions       = useAeroStore((s) => s.roomDimensions);
  const globalScale          = useAeroStore((s) => s.globalScale);
  const verifiedScaleFactor  = useAeroStore((s) => s.verifiedScaleFactor);
  const rulerActive          = useAeroStore((s) => s.rulerActive);
  const setRulerActive       = useAeroStore((s) => s.setRulerActive);
  const anchorLog            = useAeroStore((s) => s.anchorLog);
  const setVerifiedScaleFactor  = useAeroStore((s) => s.setVerifiedScaleFactor);
  const masterCeilingHeight       = useAeroStore((s) => s.masterCeilingHeight);
  const setMasterCeilingHeight    = useAeroStore((s) => s.setMasterCeilingHeight);
  const setVerifiedXAxis          = useAeroStore((s) => s.setVerifiedXAxis);
  const setVerifiedZAxis          = useAeroStore((s) => s.setVerifiedZAxis);
  const verifiedXAxis             = useAeroStore((s) => s.verifiedXAxis);
  const verifiedZAxis             = useAeroStore((s) => s.verifiedZAxis);
  const anchorRoomType            = useAeroStore((s) => s.anchorRoomType);
  const activatePreCalibration    = useAeroStore((s) => s.activatePreCalibration);

  // Tour requires room enclosure boundaries (always yields 3 corners)
  const canStartTour = roomDimensions !== null && !isTouring;

  const isBusy      = isThinking || isScanning || isDeepScanning;
  const isInputBusy = isThinking || isMoving || isScanning || isDeepScanning;

  // ── Pre-scan modal handlers ──
  function openPreScanModal(type: "quick" | "deep") {
    if (isBusy) return;
    setPreScanModal(type);
  }

  function handlePreScanConfirm(values: PreScanValues) {
    const type = preScanModal;
    setPreScanModal(null);

    // Commit all three calibration values to the store atomically before
    // the scan fires, so rawMeshDimensions are never computed without scale.
    setMasterCeilingHeight(values.masterCeilingHeight);
    setVerifiedXAxis(values.mainRoomWidth);
    setVerifiedZAxis(values.mainRoomLength);

    // Activate pre-calibration mode: locks scale to 1.0x and bypasses healers.
    activatePreCalibration(values.anchorRoomType, values.mainRoomWidth);

    // Stage room spec so resolveScan can create a hard-coded ScannedRoom
    setPendingRoomSpec({
      widthM:         values.mainRoomWidth,
      lengthM:        values.mainRoomLength,
      ceilingM:       values.masterCeilingHeight,
      anchorRoomType: values.anchorRoomType,
    });

    console.log(
      `[PreScan] Calibration committed — ` +
      `ceiling=${values.masterCeilingHeight}m ` +
      `width=${values.mainRoomWidth}m ` +
      `length=${values.mainRoomLength}m. ` +
      `Triggering ${type === "deep" ? "360° scan" : "quick scan"}.`,
    );

    if (type === "deep") triggerDeepScan();
    else triggerScan();
  }

  function handlePreScanCancel() {
    setPreScanModal(null);
  }

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || isInputBusy) return;
    setInput("");
    await sendMessage(trimmed);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleSend();
  };

  return (
    // 40% wider than the original w-80 (320px → 448px = w-[28rem])
    // Taller via generous padding + expanded message area min-h
    <div className="flex w-[28rem] flex-col gap-3 rounded-2xl border border-white/15 bg-black/75 p-5 shadow-2xl shadow-black/60 backdrop-blur-md">

      {/* ── Header row ── */}
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-widest text-white/50">
          AI Pilot
        </p>

        <div className="flex items-center gap-2">
          {/* Clear History */}
          {aiMessage && (
            <button
              onClick={clearHistory}
              title="Clear chat history"
              className="rounded-md px-2 py-1 text-[10px] font-medium text-white/30 transition-colors hover:bg-white/10 hover:text-white/60"
            >
              Clear
            </button>
          )}

          {/* Start Visual Tour — appears once ≥3 POI objects are detected */}
          {canStartTour && (
            <button
              onClick={startTour}
              disabled={isBusy}
              title="Cinematic tour of detected objects"
              className="flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 text-xs font-medium text-emerald-300/80 transition-colors hover:bg-emerald-500/25 hover:text-emerald-200 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
                <path d="M3.25 4A2.25 2.25 0 001 6.25v7.5A2.25 2.25 0 003.25 16h7.5A2.25 2.25 0 0013 13.75v-7.5A2.25 2.25 0 0010.75 4h-7.5zM19 4.75a.75.75 0 00-1.28-.53l-3 3a.75.75 0 00-.22.53v4.5c0 .199.079.39.22.53l3 3a.75.75 0 001.28-.53V4.75z" />
              </svg>
              Tour
            </button>
          )}

          {/* Reference Ruler — toggles floor-click measurement mode */}
          <button
            onClick={() => setRulerActive(!rulerActive)}
            title={rulerActive ? "Cancel ruler — click two points on the floor" : "Reference Ruler — measure real-world distance"}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
              rulerActive
                ? "border-cyan-400/60 bg-cyan-400/20 text-cyan-300 hover:bg-cyan-400/30"
                : "border-white/20 bg-white/8 text-white/50 hover:bg-white/15 hover:text-white/80"
            }`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
              <path fillRule="evenodd" d="M.99 5.24A2.25 2.25 0 013.25 3h13.5A2.25 2.25 0 0119 5.25l.01 9.5A2.25 2.25 0 0116.76 17H3.26A2.25 2.25 0 011 14.74l-.01-9.5zm8.26 9.52v-.001a.75.75 0 00.75.75h1.5a.75.75 0 00.75-.75v-4.5a.75.75 0 00-.75-.75h-1.5a.75.75 0 00-.75.75v4.5zm-3.5 0v.001a.75.75 0 00.75.75H8a.75.75 0 00.75-.75v-2.5A.75.75 0 008 11.5H6.5a.75.75 0 00-.75.75v2.5zm7 0v.001a.75.75 0 00.75.75h1.5a.75.75 0 00.75-.75v-2.5a.75.75 0 00-.75-.75H13.5a.75.75 0 00-.75.75v2.5z" clipRule="evenodd" />
            </svg>
            {rulerActive ? "Ruler ON" : "Ruler"}
          </button>

          {/* Perimeter Survey — room-by-room tour from each zone centre */}
          <button
            onClick={() => openPreScanModal("deep")}
            disabled={isBusy}
            title="360° scan — 8-frame spin from room centre, creates a new Room Object with hard-coded dimensions"
            className="flex items-center gap-1.5 rounded-lg border border-violet-500/40 bg-violet-500/15 px-3 py-1.5 text-xs font-medium text-violet-300/80 transition-colors hover:bg-violet-500/25 hover:text-violet-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isDeepScanning ? (
              <>
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5 animate-spin">
                  <path fillRule="evenodd" d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.433a.75.75 0 000-1.5H3.989a.75.75 0 00-.75.75v4.242a.75.75 0 001.5 0v-2.43l.31.31a7 7 0 0011.712-3.138.75.75 0 00-1.449-.39zm1.23-3.723a.75.75 0 00.219-.53V2.929a.75.75 0 00-1.5 0V5.36l-.31-.31A7 7 0 003.239 8.188a.75.75 0 101.448.389A5.5 5.5 0 0113.89 6.11l.311.31h-2.432a.75.75 0 000 1.5h4.243a.75.75 0 00.53-.219z" clipRule="evenodd" />
                </svg>
                {deepScanProgress}/{deepScanTotal}
              </>
            ) : (
              <>
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
                  <path fillRule="evenodd" d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.433a.75.75 0 000-1.5H3.989a.75.75 0 00-.75.75v4.242a.75.75 0 001.5 0v-2.43l.31.31a7 7 0 0011.712-3.138.75.75 0 00-1.449-.39zm1.23-3.723a.75.75 0 00.219-.53V2.929a.75.75 0 00-1.5 0V5.36l-.31-.31A7 7 0 003.239 8.188a.75.75 0 101.448.389A5.5 5.5 0 0113.89 6.11l.311.31h-2.432a.75.75 0 000 1.5h4.243a.75.75 0 00.53-.219z" clipRule="evenodd" />
                </svg>
                360°
              </>
            )}
          </button>

          {/* Scan Room — primary focal point */}
          <button
            onClick={() => openPreScanModal("quick")}
            disabled={isBusy}
            title="Auto-discover objects in the current view"
            className="flex items-center gap-1.5 rounded-lg border border-sky-500/60 bg-sky-500/20 px-3 py-1.5 text-xs font-semibold text-sky-300 shadow-sm shadow-sky-900/40 transition-colors hover:bg-sky-500/35 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isScanning && !isDeepScanning ? (
              <>
                <span className="h-1.5 w-1.5 animate-ping rounded-full bg-sky-400" />
                Scanning…
              </>
            ) : (
              <>
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
                  <path d="M10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" />
                  <path fillRule="evenodd" d="M.664 10.59a1.651 1.651 0 010-1.186A10.004 10.004 0 0110 3c4.257 0 7.893 2.66 9.336 6.41.147.381.146.804 0 1.186A10.004 10.004 0 0110 17c-4.257 0-7.893-2.66-9.336-6.41z" clipRule="evenodd" />
                </svg>
                Scan
              </>
            )}
          </button>
        </div>
      </div>

      {/* ── Detected objects list ── */}
      {detectedObjects.length > 0 && (
        <div className="relative z-50 flex flex-wrap gap-1.5">
          {detectedObjects.map((obj) => {
            const hasAccuracy = obj.volumeAccuracy !== undefined;
            const conflict    = obj.sizeConflict ?? false;
            return (
              <button
                key={obj.uid}
                onClick={() => sendMessage(`zoom in on the ${obj.name}`)}
                disabled={isBusy}
                title={
                  conflict
                    ? `⚠ Size conflict — footprint < 1 m². Re-scan for better accuracy.\n3D: (${obj.position3D.map((v) => v.toFixed(1)).join(", ")})`
                    : `3D: (${obj.position3D.map((v) => v.toFixed(1)).join(", ")})`
                }
                className={`flex flex-col items-center rounded-xl border px-3 py-1.5 text-xs font-medium shadow transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  conflict
                    ? "border-amber-400/50 bg-amber-500/20 text-amber-200 shadow-amber-900/30 hover:bg-amber-500/35 hover:text-white"
                    : "border-white/15 bg-white/8 text-white/90 shadow-black/30 hover:bg-white/15 hover:text-white"
                }`}
              >
                <span className="flex items-center gap-1">
                  {conflict && <span aria-label="size conflict">⚠️</span>}
                  {obj.name}
                </span>
                {obj.isOpening ? (
                  <span className="text-[9px] font-normal leading-none text-sky-400/80">
                    Opening
                  </span>
                ) : obj.scaleValidation === "high-confidence" ? (
                  <span className="text-[9px] font-normal leading-none text-emerald-400">
                    ✓✓ Scale OK
                  </span>
                ) : obj.scaleValidation === "scale-conflict" ? (
                  <span className="text-[9px] font-normal leading-none text-amber-400">
                    ⚠ Scale conflict
                  </span>
                ) : hasAccuracy ? (
                  <span className={`text-[9px] font-normal leading-none ${accuracyColor(obj.volumeAccuracy!)}`}>
                    {obj.volumeAccuracy}% accuracy
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}

      {/* ── Scale calibration indicator ── */}
      <ScaleIndicator
        globalScale={globalScale}
        verifiedScaleFactor={verifiedScaleFactor}
        anchorLog={anchorLog}
        setVerifiedScaleFactor={setVerifiedScaleFactor}
      />

      {/* ── AI message display ── */}
      <div className="min-h-[64px] flex items-center">
        {isDeepScanning ? (
          <div className="flex items-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5 shrink-0 animate-spin text-violet-400">
              <path fillRule="evenodd" d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.433a.75.75 0 000-1.5H3.989a.75.75 0 00-.75.75v4.242a.75.75 0 001.5 0v-2.43l.31.31a7 7 0 0011.712-3.138.75.75 0 00-1.449-.39zm1.23-3.723a.75.75 0 00.219-.53V2.929a.75.75 0 00-1.5 0V5.36l-.31-.31A7 7 0 003.239 8.188a.75.75 0 101.448.389A5.5 5.5 0 0113.89 6.11l.311.31h-2.432a.75.75 0 000 1.5h4.243a.75.75 0 00.53-.219z" clipRule="evenodd" />
            </svg>
            <span className="text-sm text-violet-300">
              {deepScanProgress > 0
                ? `Deep scan ${deepScanProgress}/${deepScanTotal}…`
                : "Starting deep scan…"}
            </span>
          </div>
        ) : isScanning ? (
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400 [animation-delay:-0.3s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400 [animation-delay:-0.15s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400" />
            <span className="ml-1 text-sm text-sky-300">Scanning for objects…</span>
          </div>
        ) : isThinking ? (
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400 [animation-delay:-0.3s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400 [animation-delay:-0.15s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400" />
            <span className="ml-1 text-sm text-sky-300">AeroPilot is thinking…</span>
          </div>
        ) : isMoving && aiMessage ? (
          <div className="flex items-start gap-2">
            <span className="mt-0.5 h-2 w-2 shrink-0 animate-ping rounded-full bg-sky-400" />
            <p className="text-sm leading-snug text-white">{aiMessage}</p>
          </div>
        ) : aiMessage ? (
          <p className="text-sm leading-snug text-white">{aiMessage}</p>
        ) : (
          <p className="text-sm text-white/35">Ask about this space…</p>
        )}
      </div>

      {/* ── Input row ── */}
      <div className="flex items-center gap-2 rounded-xl border border-white/15 bg-white/8 px-3 py-2.5">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isInputBusy}
          placeholder={
            isDeepScanning
              ? `Deep scan ${deepScanProgress}/${deepScanTotal}…`
              : isScanning
              ? "Scanning…"
              : detectedObjects.length > 0
              ? `zoom in on the ${detectedObjects[0].name}…`
              : isInputBusy
              ? "Please wait…"
              : "Take me to the kitchen…"
          }
          className="flex-1 bg-transparent text-sm text-white placeholder-white/30 outline-none disabled:cursor-not-allowed disabled:opacity-50"
        />
        <button
          onClick={handleSend}
          disabled={isInputBusy || !input.trim()}
          aria-label="Send"
          className="flex h-7 w-7 items-center justify-center rounded-lg bg-sky-500 text-white transition-colors hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
            <path d="M3.105 2.289a.75.75 0 00-.826.95l1.903 6.557H13.5a.75.75 0 010 1.5H4.182l-1.903 6.557a.75.75 0 00.826.95 28.896 28.896 0 0015.293-7.154.75.75 0 000-1.115A28.897 28.897 0 003.105 2.289z" />
          </svg>
        </button>
      </div>

      {/* ── Pre-Scan Calibration Modal ── */}
      {preScanModal && (
        <PreScanModal
          scanType={preScanModal}
          initial={{
            masterCeilingHeight: masterCeilingHeight ?? undefined,
            mainRoomWidth:       verifiedXAxis       ?? undefined,
            mainRoomLength:      verifiedZAxis       ?? undefined,
            anchorRoomType:      anchorRoomType      ?? undefined,
          }}
          onConfirm={handlePreScanConfirm}
          onCancel={handlePreScanCancel}
        />
      )}
    </div>
  );
}
