"use client";

import { useState, useRef, KeyboardEvent } from "react";
import { useAeroStore } from "@/store/useAeroStore";

export function ChatInput() {
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const sendMessage = useAeroStore((s) => s.sendMessage);
  const triggerScan = useAeroStore((s) => s.triggerScan);
  const triggerDeepScan = useAeroStore((s) => s.triggerDeepScan);
  const aiMessage = useAeroStore((s) => s.aiMessage);
  const isThinking = useAeroStore((s) => s.isThinking);
  const isMoving = useAeroStore((s) => s.isMoving);
  const isScanning = useAeroStore((s) => s.isScanning);
  const isDeepScanning = useAeroStore((s) => s.isDeepScanning);
  const deepScanProgress = useAeroStore((s) => s.deepScanProgress);
  const deepScanTotal = useAeroStore((s) => s.deepScanTotal);
  const detectedObjects = useAeroStore((s) => s.detectedObjects);

  // isMoving should NOT block pill clicks — the user can re-target while the camera
  // is still travelling. Only block when the AI is actively thinking or scanning.
  const isBusy = isThinking || isScanning || isDeepScanning;
  const isInputBusy = isThinking || isMoving || isScanning || isDeepScanning;

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
    <div className="flex w-80 flex-col gap-2 rounded-2xl border border-white/10 bg-black/50 p-4 backdrop-blur-sm">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-widest text-white/40">
          AI Pilot
        </p>

        <div className="flex items-center gap-1.5">
          {/* Scan Room button — single-angle capture */}
          <button
            onClick={triggerScan}
            disabled={isBusy}
            title="Auto-discover objects in the current view"
            className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs font-medium text-white/60 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isScanning && !isDeepScanning ? (
              <>
                <span className="h-1.5 w-1.5 animate-ping rounded-full bg-violet-400" />
                Scanning…
              </>
            ) : (
              <>
                {/* Eye icon */}
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
                  <path d="M10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" />
                  <path fillRule="evenodd" d="M.664 10.59a1.651 1.651 0 010-1.186A10.004 10.004 0 0110 3c4.257 0 7.893 2.66 9.336 6.41.147.381.146.804 0 1.186A10.004 10.004 0 0110 17c-4.257 0-7.893-2.66-9.336-6.41z" clipRule="evenodd" />
                </svg>
                Scan
              </>
            )}
          </button>

          {/* Deep Scan button — automated 360° sweep */}
          <button
            onClick={triggerDeepScan}
            disabled={isBusy}
            title="Auto-discover objects with a full 360° room sweep"
            className="flex items-center gap-1.5 rounded-lg border border-violet-500/30 bg-violet-500/10 px-2.5 py-1 text-xs font-medium text-violet-300/70 transition-colors hover:bg-violet-500/20 hover:text-violet-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isDeepScanning ? (
              <>
                {/* Spinning indicator */}
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5 animate-spin">
                  <path fillRule="evenodd" d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.433a.75.75 0 000-1.5H3.989a.75.75 0 00-.75.75v4.242a.75.75 0 001.5 0v-2.43l.31.31a7 7 0 0011.712-3.138.75.75 0 00-1.449-.39zm1.23-3.723a.75.75 0 00.219-.53V2.929a.75.75 0 00-1.5 0V5.36l-.31-.31A7 7 0 003.239 8.188a.75.75 0 101.448.389A5.5 5.5 0 0113.89 6.11l.311.31h-2.432a.75.75 0 000 1.5h4.243a.75.75 0 00.53-.219z" clipRule="evenodd" />
                </svg>
                {deepScanProgress}/{deepScanTotal}
              </>
            ) : (
              <>
                {/* Sync / 360 icon */}
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
                  <path fillRule="evenodd" d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.433a.75.75 0 000-1.5H3.989a.75.75 0 00-.75.75v4.242a.75.75 0 001.5 0v-2.43l.31.31a7 7 0 0011.712-3.138.75.75 0 00-1.449-.39zm1.23-3.723a.75.75 0 00.219-.53V2.929a.75.75 0 00-1.5 0V5.36l-.31-.31A7 7 0 003.239 8.188a.75.75 0 101.448.389A5.5 5.5 0 0113.89 6.11l.311.31h-2.432a.75.75 0 000 1.5h4.243a.75.75 0 00.53-.219z" clipRule="evenodd" />
                </svg>
                360°
              </>
            )}
          </button>
        </div>
      </div>

      {/* Detected objects list */}
      {detectedObjects.length > 0 && (
        <div className="relative z-50 flex flex-wrap gap-1">
          {detectedObjects.map((obj) => (
            <button
              key={obj.name}
              onClick={() => sendMessage(`zoom in on the ${obj.name}`)}
              disabled={isBusy}
              title={
                obj.sizeConflict
                  ? `⚠ Size conflict — footprint < 1 m² for "${obj.name}". Re-scan for better accuracy.\n3D: (${obj.position3D.map((v) => v.toFixed(1)).join(", ")})`
                  : `3D: (${obj.position3D.map((v) => v.toFixed(1)).join(", ")})`
              }
              className={`flex flex-col items-center rounded-full border px-2.5 py-1 text-xs font-medium shadow-md transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                obj.sizeConflict
                  ? "border-amber-400/50 bg-amber-500/20 text-amber-200 shadow-amber-900/40 hover:bg-amber-500/40 hover:text-white"
                  : "border-violet-400/50 bg-violet-500/20 text-violet-200 shadow-violet-900/40 hover:bg-violet-500/40 hover:text-white"
              }`}
            >
              <span className="flex items-center gap-1">
                {obj.sizeConflict && <span aria-label="size conflict">⚠️</span>}
                {obj.name}
              </span>
              {obj.confidence !== undefined && (
                <span className={`text-[9px] font-normal leading-none ${obj.sizeConflict ? "text-amber-400/70" : "text-violet-400/70"}`}>
                  {Math.round(obj.confidence * 100)}%
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* AI message display */}
      <div className="min-h-[40px] flex items-center">
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
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-violet-400 [animation-delay:-0.3s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-violet-400 [animation-delay:-0.15s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-violet-400" />
            <span className="ml-1 text-sm text-violet-300">Scanning for objects…</span>
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
            <p className="text-sm leading-snug text-white/80">{aiMessage}</p>
          </div>
        ) : aiMessage ? (
          <p className="text-sm leading-snug text-white/80">{aiMessage}</p>
        ) : (
          <p className="text-sm text-white/30">Ask about this space…</p>
        )}
      </div>

      {/* Input row */}
      <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2">
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
    </div>
  );
}
