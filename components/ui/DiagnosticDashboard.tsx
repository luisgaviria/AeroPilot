"use client";

import { useState, useRef } from "react";
import { useAeroStore } from "@/store/useAeroStore";
import type { BoundaryPlanes } from "@/types/diagnostics";
import { fmtLen, fmtArea } from "@/utils/units";

// ── Shared primitives ────────────────────────────────────────────────────────

type Severity = "ok" | "warn" | "error";

function StatusDot({ severity }: { severity: Severity }) {
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${
        severity === "ok"
          ? "bg-emerald-400"
          : severity === "warn"
          ? "bg-amber-400"
          : "bg-red-400"
      }`}
    />
  );
}

function GapRow({ severity, text }: { severity: Severity; text: string }) {
  const labelColor =
    severity === "ok"
      ? "text-emerald-400"
      : severity === "warn"
      ? "text-amber-300"
      : "text-red-400";
  const tag =
    severity === "error" ? "Error" : severity === "warn" ? "Warning" : "OK";
  return (
    <li className="flex gap-2 text-[11px] leading-snug">
      <StatusDot severity={severity} />
      <span>
        <span className={`font-semibold ${labelColor}`}>{tag}: </span>
        <span className="text-white/65">{text}</span>
      </span>
    </li>
  );
}

function PillarCell({
  label,
  value,
  status,
  note,
}: {
  label: string;
  value: string;
  status: Severity;
  note: string;
}) {
  const valueColor =
    status === "ok"
      ? "text-emerald-400"
      : status === "warn"
      ? "text-amber-400"
      : "text-red-400";
  return (
    <div className="bg-black/40 px-4 py-3">
      <p className="text-[9px] font-medium uppercase tracking-widest text-white/30">{label}</p>
      <p className={`mt-0.5 text-lg font-semibold tabular-nums leading-none ${valueColor}`}>
        {value}
      </p>
      <p className="mt-1 text-[9px] leading-snug text-white/35">{note}</p>
    </div>
  );
}

function InjectionRow({
  label,
  unit,
  currentValue,
  placeholder,
  value,
  onChange,
  onSet,
  onClear,
  isVerified,
}: {
  label: string;
  unit: string;
  currentValue: number | undefined;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  onSet: (v: number) => void;
  onClear: () => void;
  isVerified: boolean;
}) {
  function commit() {
    const n = parseFloat(value);
    if (Number.isFinite(n) && n > 0) onSet(n);
  }

  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-medium text-white/70">
          {label}
          {isVerified && (
            <span className="ml-1.5 text-[9px] font-semibold text-amber-400">
              ● Verified
            </span>
          )}
        </p>
        {currentValue != null && (
          <p className="text-[9px] text-white/30">
            {fmtLen(currentValue)}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <input
          type="number"
          step="0.01"
          min="0.1"
          max="99"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
          placeholder={placeholder}
          className="w-20 rounded border border-white/15 bg-black/40 px-2 py-1 text-[11px] text-white outline-none placeholder-white/20 focus:border-amber-400/50"
        />
        <span className="text-[10px] text-white/30">{unit}</span>
        <button
          onClick={commit}
          className="rounded px-2 py-1 text-[10px] font-medium text-emerald-400 transition-colors hover:bg-white/10"
        >
          Set
        </button>
        {isVerified && (
          <button
            onClick={onClear}
            title="Clear override"
            className="rounded px-1.5 py-1 text-[10px] text-white/30 transition-colors hover:bg-white/10 hover:text-white/60"
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}

// ── Main dashboard ───────────────────────────────────────────────────────────

export function DiagnosticDashboard() {
  const [open,        setOpen]       = useState(false);
  const [ceilInput,   setCeilInput]  = useState("");
  const [lenInput,    setLenInput]   = useState("");
  const [widInput,    setWidInput]   = useState("");
  const [scaleInput,  setScaleInput] = useState("");
  const [nameSynced, setNameSynced] = useState(false);
  const nameTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const roomDimensions        = useAeroStore((s) => s.roomDimensions);
  const spatialDiagnostics    = useAeroStore((s) => s.spatialDiagnostics);
  const verifiedScaleFactor   = useAeroStore((s) => s.verifiedScaleFactor);
  const globalScale           = useAeroStore((s) => s.globalScale);
  const anchorLog             = useAeroStore((s) => s.anchorLog);
  const metricRatio           = useAeroStore((s) => s.metricRatio);
  const verifiedYAxis         = useAeroStore((s) => s.verifiedYAxis);
  const verifiedXAxis         = useAeroStore((s) => s.verifiedXAxis);
  const verifiedZAxis         = useAeroStore((s) => s.verifiedZAxis);
  const setVerifiedYAxis      = useAeroStore((s) => s.setVerifiedYAxis);
  const setVerifiedXAxis      = useAeroStore((s) => s.setVerifiedXAxis);
  const setVerifiedZAxis      = useAeroStore((s) => s.setVerifiedZAxis);
  const detectedObjects       = useAeroStore((s) => s.detectedObjects);
  const triggerFloorSnap      = useAeroStore((s) => s.triggerFloorSnap);
  const exportSpatialManifest = useAeroStore((s) => s.exportSpatialManifest);
  const currentRoomName       = useAeroStore((s) => s.currentRoomName);
  const setCurrentRoomName    = useAeroStore((s) => s.setCurrentRoomName);
  const saveCurrentRoom       = useAeroStore((s) => s.saveCurrentRoom);
  const resetForNewScan       = useAeroStore((s) => s.resetForNewScan);
  const spatialMode           = useAeroStore((s) => s.spatialMode);
  const setSpatialMode        = useAeroStore((s) => s.setSpatialMode);
  const vectorSynced          = useAeroStore((s) => s._vectorSynced);
  const lockedScale           = useAeroStore((s) => s._lockedScale);
  const setManualScale        = useAeroStore((s) => s.setManualScale);

  const defaultName = `Space-Scan-${new Date().toISOString().slice(0, 10)}-…`;
  const [nameInput, setNameInput] = useState(currentRoomName ?? "");

  function commitName(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;
    setCurrentRoomName(trimmed);
    setTimeout(() => saveCurrentRoom().catch(() => {}), 0);
    if (nameTimeoutRef.current) clearTimeout(nameTimeoutRef.current);
    setNameSynced(true);
    nameTimeoutRef.current = setTimeout(() => setNameSynced(false), 3000);
  }

  const diag = spatialDiagnostics;
  const bp: BoundaryPlanes | undefined = diag?.boundaryPlanes;

  // ── Pillar status derivations ─────────────────────────────────────────────
  const scaleVerified    = verifiedScaleFactor != null;
  const hasRoomOverrides = verifiedXAxis != null || verifiedZAxis != null || verifiedYAxis != null;
  const axesUniform      = Math.abs(globalScale.x - globalScale.y) < 0.001 && Math.abs(globalScale.x - globalScale.z) < 0.001;
  // Skew: horizontal-plane divergence between X and Z axes.
  const skewRatio        = Math.abs(globalScale.x - globalScale.z) / Math.max(globalScale.x, globalScale.z);
  const hasSkew          = skewRatio > 0.20;

  const tiltDeg      = diag?.verticalityError ?? 0;
  const vertStatus: Severity = tiltDeg >= 5 ? "error" : tiltDeg >= 2 ? "warn" : "ok";

  const wallsOk     = bp ? [bp.wallN, bp.wallS, bp.wallE, bp.wallW].filter(Boolean).length : 0;
  const planesOk    = bp ? [bp.floor, bp.ceiling, bp.wallN, bp.wallS, bp.wallE, bp.wallW].filter(Boolean).length : 0;
  const boundStatus: Severity = !bp ? "error" : planesOk === 6 ? "ok" : planesOk >= 4 ? "warn" : "error";

  // ── Dynamic axis labels — environment-agnostic ────────────────────────────
  // ≥ 3 walls: room context confirmed → use architectural names.
  // < 3 walls: exterior / drone / unknown → use axis names.
  const axisLabel = (axis: "x" | "y" | "z"): string => {
    if (wallsOk >= 3) {
      if (axis === "x") return "Room Width";
      if (axis === "z") return "Room Length";
      return "Ceiling";
    }
    if (axis === "x") return "X-Axis Baseline";
    if (axis === "z") return "Z-Axis Baseline";
    return "Altitude";
  };

  // ── Data gap report ───────────────────────────────────────────────────────
  const gaps: Array<{ severity: Severity; text: string }> = [];

  // Scale
  if (!metricRatio && !scaleVerified && !hasRoomOverrides) {
    gaps.push({ severity: "warn", text: "Metric Integrity unverified. Use the Reference Ruler or inject room dimensions." });
  } else {
    const scaleDesc = metricRatio != null
      ? `metricRatio ${metricRatio.toFixed(4)}× (X:${globalScale.x.toFixed(3)} Z:${globalScale.z.toFixed(3)})`
      : scaleVerified
      ? `${verifiedScaleFactor!.toFixed(3)}× uniform (${anchorLog.filter((m) => m.included).length} anchors)`
      : `per-axis X:${globalScale.x.toFixed(3)} Y:${globalScale.y.toFixed(3)} Z:${globalScale.z.toFixed(3)}`;
    gaps.push({ severity: "ok", text: `Metric Integrity OK — ${scaleDesc}.` });
  }

  // Skew warning — large divergence between X and Z axes distorts floor-plan proportions.
  if (hasSkew) {
    gaps.push({
      severity: "warn",
      text: `Scale skew detected: X=${globalScale.x.toFixed(3)}× vs Z=${globalScale.z.toFixed(3)}× (${(skewRatio * 100).toFixed(0)}% divergence). Room proportions may be distorted.`,
    });
  }

  // Hybrid Validation — per-object scale conflicts from the 70/30 pass.
  const scaleConflicts = detectedObjects.filter((o) => o.scaleValidation === "scale-conflict");
  for (const obj of scaleConflicts) {
    gaps.push({
      severity: "warn",
      text: `⚠ Scale Conflict "${obj.name}": ${obj.scaleConflictMsg ?? "geometric vs standard mismatch"} — geometry kept, re-scan for better accuracy.`,
    });
  }

  // Hybrid Validation — summary of high-confidence objects.
  const highConfCount = detectedObjects.filter((o) => o.scaleValidation === "high-confidence").length;
  if (highConfCount > 0) {
    gaps.push({
      severity: "ok",
      text: `${highConfCount} object${highConfCount > 1 ? "s" : ""} ✓✓ passed Hybrid Validation (geometry + AI agree within 15%).`,
    });
  }

  // Ceiling / altitude height
  if (diag?.ceilingHeightSource === "fallback") {
    const hStr = roomDimensions ? fmtLen(roomDimensions.height) : "?";
    gaps.push({
      severity: "warn",
      text: `${axisLabel("y")} plane noisy. Height (${hStr}) is a fallback estimate.`,
    });
  } else if (diag?.ceilingHeightSource === "verified") {
    const hStr = verifiedYAxis != null ? fmtLen(verifiedYAxis) : "?";
    gaps.push({ severity: "ok", text: `${axisLabel("y")} verified at ${hStr}.` });
  }

  // Openings
  const openings = diag?.openingsDetected ?? 0;
  if (openings === 0) {
    gaps.push({ severity: "error", text: "No openings detected. Portal traversal disabled." });
  } else {
    gaps.push({ severity: "ok", text: `${openings} opening(s) detected. Portal traversal enabled.` });
  }

  // Verticality
  if (vertStatus === "error") {
    gaps.push({ severity: "error", text: `Model tilted ${tiltDeg.toFixed(1)}°. Y-axis misaligned — drone logic compromised.` });
  } else if (vertStatus === "warn") {
    gaps.push({ severity: "warn", text: `Minor tilt detected (${tiltDeg.toFixed(1)}°). Consider using Snap to Floor.` });
  }

  // Ceiling plane
  if (bp && !bp.ceiling) {
    gaps.push({ severity: "warn", text: "Ceiling plane not detected. Re-scan from a low angle." });
  }

  // Wall planes
  if (wallsOk < 4) {
    gaps.push({ severity: "warn", text: `${4 - wallsOk} wall plane(s) missing. Boundary enclosure incomplete.` });
  }

  // ── Overall health ────────────────────────────────────────────────────────
  const errs  = gaps.filter((g) => g.severity === "error").length;
  const warns = gaps.filter((g) => g.severity === "warn").length;
  const health: Severity     = errs > 0 ? "error" : warns > 0 ? "warn" : "ok";
  const healthLabel          = errs > 0 ? "Critical" : warns > 0 ? "Degraded" : "Nominal";

  const toggleBorder =
    health === "ok"
      ? "border-emerald-500/30 text-emerald-300"
      : health === "warn"
      ? "border-amber-500/40 text-amber-300"
      : "border-red-500/40 text-red-300";

  return (
    <div className="flex flex-col items-start gap-2">
      {/* ── Toggle button ── */}
      <button
        onClick={() => setOpen((v) => !v)}
        title="Spatial Diagnostic Dashboard"
        className={`flex items-center gap-2 rounded-xl border bg-black/70 px-3 py-2 text-xs font-medium backdrop-blur-md transition-colors hover:bg-black/90 ${toggleBorder}`}
      >
        <StatusDot severity={health} />
        <span>Diagnostics</span>
        <span className="text-[10px] opacity-55">{healthLabel}</span>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path
            fillRule="evenodd"
            d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {/* ── Dashboard panel ── */}
      {open && (
        <div className="w-[26rem] rounded-2xl border border-white/12 bg-black/82 shadow-2xl shadow-black/60 backdrop-blur-md">
          {/* Header */}
          <div className="border-b border-white/10 px-5 py-3">
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-white/35">
              Spatial Diagnostic Dashboard
            </p>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={nameInput}
                placeholder={defaultName}
                onChange={(e) => setNameInput(e.target.value)}
                onBlur={(e) => commitName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.currentTarget.blur(); } }}
                className="min-w-0 flex-1 rounded border border-white/15 bg-black/40 px-2 py-1 text-[12px] font-medium text-white outline-none placeholder-white/20 focus:border-sky-400/60"
              />
              {nameSynced && (
                <span className="flex shrink-0 items-center gap-1 text-[10px] text-emerald-400">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  Synced
                </span>
              )}
              {/* Vector Sync indicator — shows embedding status independently of name save */}
              {vectorSynced === true && (
                <span
                  title="Space indexed — AI semantic search enabled"
                  className="flex shrink-0 items-center gap-1 text-[10px] text-violet-400"
                >
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-violet-400" />
                  Vector Sync
                </span>
              )}
              {vectorSynced === false && (
                <span
                  title="Embedding failed — spatial data saved, vector index pending"
                  className="flex shrink-0 items-center gap-1 text-[10px] text-amber-400"
                >
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400" />
                  No Vector
                </span>
              )}
            </div>
            {/* Space Type selector */}
            <div className="mt-2 flex items-center gap-2">
              <p className="shrink-0 text-[10px] text-white/35">Space Type</p>
              <select
                value={spatialMode}
                onChange={(e) => {
                  setSpatialMode(e.target.value as typeof spatialMode);
                  setTimeout(() => saveCurrentRoom().catch(() => {}), 0);
                }}
                className="flex-1 rounded border border-white/15 bg-black/60 px-2 py-1 text-[11px] text-white outline-none focus:border-sky-400/60"
              >
                <option value="room">Room — enclosed interior</option>
                <option value="open-plan">Open Plan — no full enclosure</option>
                <option value="outdoor">Outdoor — ground level</option>
                <option value="aerial">Aerial — drone / overhead</option>
              </select>
            </div>
          </div>

          {/* ── Pillar Health Grid ── */}
          <div className="grid grid-cols-3 gap-px border-b border-white/10 bg-white/5">
            <PillarCell
              label="Metric Integrity"
              value={
                lockedScale != null
                  ? `${lockedScale.toFixed(4)}×`
                  : metricRatio != null
                  ? `${metricRatio.toFixed(4)}×`
                  : scaleVerified
                  ? `${verifiedScaleFactor!.toFixed(3)}×`
                  : globalScale.x !== 1.0
                  ? `~${globalScale.x.toFixed(3)}×`
                  : "—"
              }
              status={lockedScale != null || metricRatio != null || scaleVerified || hasRoomOverrides ? "ok" : "warn"}
              note={
                lockedScale != null
                  ? "Scale locked"
                  : metricRatio != null
                  ? hasRoomOverrides ? "Room dims verified" : "Ruler verified"
                  : scaleVerified
                  ? "Tape Measure verified"
                  : "Auto-estimate only"
              }
            />
            <PillarCell
              label="Verticality"
              value={diag ? `${tiltDeg.toFixed(1)}°` : "—"}
              status={vertStatus}
              note={
                vertStatus === "error"
                  ? "Tilt critical"
                  : vertStatus === "warn"
                  ? "Minor tilt"
                  : "Y-axis aligned"
              }
            />
            <PillarCell
              label="Boundaries"
              value={bp ? `${planesOk}/6` : "—"}
              status={boundStatus}
              note={
                bp
                  ? `${wallsOk}/4 walls · ceiling ${bp.ceiling ? "✓" : "✗"}`
                  : "No scan yet"
              }
            />
          </div>

          {/* ── Data Gap Report ── */}
          <div className="border-b border-white/10 px-5 py-3">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-white/30">
              Data Gap Report
            </p>
            <ul className="space-y-1.5">
              {gaps.map((g, i) => (
                <GapRow key={i} severity={g.severity} text={g.text} />
              ))}
            </ul>
          </div>

          {/* ── Manual Data Injection ── */}
          <div className="border-b border-white/10 px-5 py-4">
            <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-white/30">
              Manual Data Injection
            </p>
            <div className="space-y-3">
              <InjectionRow
                label={`Verified ${axisLabel("y")}`}
                unit="m"
                currentValue={verifiedYAxis ?? roomDimensions?.height}
                placeholder={roomDimensions ? roomDimensions.height.toFixed(3) : "e.g. 2.438"}
                value={ceilInput}
                onChange={setCeilInput}
                onSet={(v) => { setVerifiedYAxis(v); setCeilInput(""); }}
                onClear={() => setVerifiedYAxis(null)}
                isVerified={verifiedYAxis != null}
              />
              <InjectionRow
                label={`Verified ${axisLabel("z")}`}
                unit="m"
                currentValue={verifiedZAxis ?? roomDimensions?.length}
                placeholder={roomDimensions ? roomDimensions.length.toFixed(2) : "e.g. 7.32"}
                value={lenInput}
                onChange={setLenInput}
                onSet={(v) => { setVerifiedZAxis(v); setLenInput(""); }}
                onClear={() => setVerifiedZAxis(null)}
                isVerified={verifiedZAxis != null}
              />
              <InjectionRow
                label={`Verified ${axisLabel("x")}`}
                unit="m"
                currentValue={verifiedXAxis ?? roomDimensions?.width}
                placeholder={roomDimensions ? roomDimensions.width.toFixed(2) : "e.g. 4.57"}
                value={widInput}
                onChange={setWidInput}
                onSet={(v) => { setVerifiedXAxis(v); setWidInput(""); }}
                onClear={() => setVerifiedXAxis(null)}
                isVerified={verifiedXAxis != null}
              />

              {/* Reconciled area readout — only shown when both X + Z axes are verified */}
              {verifiedXAxis != null && verifiedZAxis != null && (
                <div className="flex items-center justify-between rounded-lg border border-emerald-500/20 bg-emerald-500/8 px-3 py-2">
                  <p className="text-[10px] text-white/50">Verified Floor Area</p>
                  <p className="text-[11px] font-semibold text-emerald-300">
                    {fmtArea(verifiedXAxis * verifiedZAxis)}
                  </p>
                </div>
              )}

              {/* ── Manual Scale Factor / Scale Lock ── */}
              <div className={`rounded-lg border px-3 py-2.5 ${
                lockedScale != null
                  ? "border-amber-500/40 bg-amber-500/10"
                  : "border-white/10 bg-white/4"
              }`}>
                <div className="mb-2 flex items-center justify-between">
                  <div>
                    <p className="text-[11px] font-medium text-white/70">
                      Manual Scale Factor
                      {lockedScale != null && (
                        <span className="ml-1.5 rounded bg-amber-500/20 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-300">
                          Locked
                        </span>
                      )}
                    </p>
                    <p className="text-[9px] leading-snug text-white/30">
                      {lockedScale != null
                        ? `Scale locked at ${lockedScale.toFixed(4)}× — scans cannot override this`
                        : `Current: ${globalScale.x.toFixed(4)}× — override and lock to freeze geometry`}
                    </p>
                  </div>
                  {lockedScale != null && (
                    <button
                      onClick={() => { setManualScale(null); setScaleInput(""); }}
                      title="Unlock — revert to auto scale computation"
                      className="rounded-lg border border-white/15 bg-black/40 px-2.5 py-1 text-[10px] text-white/50 transition-colors hover:border-rose-500/40 hover:text-rose-300"
                    >
                      Unlock
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    step="0.0001"
                    min="0.01"
                    max="20"
                    value={scaleInput}
                    onChange={(e) => setScaleInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        const n = parseFloat(scaleInput);
                        if (Number.isFinite(n) && n > 0) { setManualScale(n); setScaleInput(""); }
                      }
                    }}
                    placeholder={lockedScale != null ? lockedScale.toFixed(4) : globalScale.x.toFixed(4)}
                    className="min-w-0 flex-1 rounded border border-white/15 bg-black/40 px-2 py-1 text-[11px] font-mono text-white outline-none placeholder-white/20 focus:border-amber-400/60"
                  />
                  <button
                    onClick={() => {
                      const n = parseFloat(scaleInput);
                      if (Number.isFinite(n) && n > 0) { setManualScale(n); setScaleInput(""); }
                    }}
                    disabled={!scaleInput.trim() || !Number.isFinite(parseFloat(scaleInput)) || parseFloat(scaleInput) <= 0}
                    title="Apply and lock this scale factor"
                    className="rounded-lg border border-amber-500/40 bg-amber-500/15 px-3 py-1 text-[10px] font-medium text-amber-300 transition-colors hover:bg-amber-500/25 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Lock
                  </button>
                </div>
              </div>

              {/* Snap to Floor */}
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[11px] font-medium text-white/70">Snap to Floor</p>
                  <p className="text-[9px] leading-snug text-white/30">
                    {diag
                      ? `Current tilt: ${tiltDeg.toFixed(1)}° — `
                      : ""}
                    Rotates model to align floor with world Y-axis
                  </p>
                </div>
                <button
                  onClick={triggerFloorSnap}
                  disabled={!roomDimensions}
                  className="rounded-lg border border-sky-500/30 bg-sky-500/15 px-3 py-1.5 text-[11px] font-medium text-sky-300 transition-colors hover:bg-sky-500/25 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Snap
                </button>
              </div>
            </div>
          </div>

          {/* ── Export + New Scan ── */}
          <div className="flex flex-col gap-2 px-5 py-3">
            <button
              onClick={exportSpatialManifest}
              disabled={!roomDimensions}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-violet-500/30 bg-violet-500/10 py-2.5 text-[11px] font-medium text-violet-300 transition-colors hover:bg-violet-500/20 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
                className="h-3.5 w-3.5"
              >
                <path d="M10.75 2.75a.75.75 0 00-1.5 0v8.614L6.295 8.235a.75.75 0 10-1.09 1.03l4.25 4.5a.75.75 0 001.09 0l4.25-4.5a.75.75 0 00-1.09-1.03l-2.955 3.129V2.75z" />
                <path d="M3.5 12.75a.75.75 0 00-1.5 0v2.5A2.75 2.75 0 004.75 18h10.5A2.75 2.75 0 0018 15.25v-2.5a.75.75 0 00-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5z" />
              </svg>
              Export Spatial Manifest
            </button>
            <button
              onClick={() => { resetForNewScan(); setNameInput(""); setOpen(false); }}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/8 py-2.5 text-[11px] font-medium text-rose-300 transition-colors hover:bg-rose-500/15"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
                <path fillRule="evenodd" d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.433a.75.75 0 000-1.5H3.989a.75.75 0 00-.75.75v4.242a.75.75 0 001.5 0v-2.43l.31.31a7 7 0 0011.712-3.138.75.75 0 00-1.449-.389zm1.23-3.723a.75.75 0 00.219-.53V2.929a.75.75 0 00-1.5 0V5.36l-.31-.31A7 7 0 003.239 8.188a.75.75 0 101.448.389A5.5 5.5 0 0113.89 6.11l.311.31h-2.432a.75.75 0 000 1.5h4.243a.75.75 0 00.53-.219z" clipRule="evenodd" />
              </svg>
              New Scan
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
