"use client";

import { useState, useEffect, useRef, KeyboardEvent } from "react";

export interface PreScanValues {
  masterCeilingHeight: number;
  mainRoomWidth: number;
  mainRoomLength: number;
  /** Which room/zone the width measurement anchors to (e.g. "Living Room"). */
  anchorRoomType: string;
}

const ANCHOR_ROOM_OPTIONS = [
  "Living Room",
  "Bedroom",
  "Kitchen",
  "Dining Room",
  "Hallway",
  "Office",
] as const;

interface Props {
  /**
   * Initial values to pre-populate when the modal opens (e.g. from a previous
   * scan session so the user doesn't re-type the same room every time).
   */
  initial?: Partial<PreScanValues>;
  /** Called when the user confirms all three fields.  Triggers the scan. */
  onConfirm: (values: PreScanValues) => void;
  /** Called when the user dismisses the modal without starting a scan. */
  onCancel: () => void;
  /** "quick" shows "Scan" label; "deep" shows "360° Scan" label. */
  scanType: "quick" | "deep";
}

type DraftKey = "masterCeilingHeight" | "mainRoomWidth" | "mainRoomLength";

const FIELD_META: {
  key: DraftKey;
  label: string;
  hint: string;
  placeholder: string;
}[] = [
  {
    key: "masterCeilingHeight",
    label: "Ceiling Height",
    hint: "e.g. 2.40  or  8ft  or  8ft 2in",
    placeholder: "2.40 m",
  },
  {
    key: "mainRoomWidth",
    label: "Anchor Room Width",
    hint: "e.g. 4.50  or  14ft 9in  or  14.75ft",
    placeholder: "4.50 m",
  },
  {
    key: "mainRoomLength",
    label: "Room Length",
    hint: "e.g. 6.00  or  19ft 8in  or  6m",
    placeholder: "6.00 m",
  },
];

/**
 * Parse a measurement string to metres.
 * Supported formats:
 *   "4.5"         → 4.5 m (bare number assumed metres)
 *   "4.5m"        → 4.5 m
 *   "16ft 5in"    → 5.004 m
 *   "16'5\""      → 5.004 m
 *   "16.5ft"      → 5.029 m
 *   "5ft"         → 1.524 m
 *   "8in" / "8\"" → 0.203 m
 */
function parseImperialToMeters(raw: string): number | null {
  if (!raw.trim()) return null;

  const s = raw.trim().toLowerCase().replace(/,/g, ".");

  // Metres suffix (explicit)
  const mMatch = s.match(/^([0-9]*\.?[0-9]+)\s*m$/);
  if (mMatch) {
    const n = parseFloat(mMatch[1]);
    return Number.isFinite(n) && n > 0 ? +n.toFixed(4) : null;
  }

  // Feet + optional inches: "16ft 5in", "16'5\"", "16ft5in", "16' 5\""
  const ftInMatch = s.match(
    /^([0-9]*\.?[0-9]+)\s*(?:ft|')\s*([0-9]*\.?[0-9]+)\s*(?:in|")?$/
  );
  if (ftInMatch) {
    const ft = parseFloat(ftInMatch[1]);
    const ins = parseFloat(ftInMatch[2]);
    if (!Number.isFinite(ft) || !Number.isFinite(ins)) return null;
    const metres = ft * 0.3048 + ins * 0.0254;
    return metres > 0 ? +metres.toFixed(4) : null;
  }

  // Feet only: "16ft", "16.5ft", "16'"
  const ftMatch = s.match(/^([0-9]*\.?[0-9]+)\s*(?:ft|')$/);
  if (ftMatch) {
    const ft = parseFloat(ftMatch[1]);
    if (!Number.isFinite(ft)) return null;
    const metres = ft * 0.3048;
    return metres > 0 ? +metres.toFixed(4) : null;
  }

  // Inches only: "8in", "8\""
  const inMatch = s.match(/^([0-9]*\.?[0-9]+)\s*(?:in|")$/);
  if (inMatch) {
    const ins = parseFloat(inMatch[1]);
    if (!Number.isFinite(ins)) return null;
    const metres = ins * 0.0254;
    return metres > 0 ? +metres.toFixed(4) : null;
  }

  // Bare number — assumed metres
  const bare = parseFloat(s);
  return Number.isFinite(bare) && bare > 0 ? +bare.toFixed(4) : null;
}

// Keep alias for clarity
const parsePositive = parseImperialToMeters;

export function PreScanModal({
  initial = {},
  onConfirm,
  onCancel,
  scanType,
}: Props) {
  const [drafts, setDrafts] = useState<Record<DraftKey, string>>({
    masterCeilingHeight: initial.masterCeilingHeight?.toString() ?? "",
    mainRoomWidth: initial.mainRoomWidth?.toString() ?? "",
    mainRoomLength: initial.mainRoomLength?.toString() ?? "",
  });
  const [errors, setErrors] = useState<Record<DraftKey, boolean>>({
    masterCeilingHeight: false,
    mainRoomWidth: false,
    mainRoomLength: false,
  });
  const [anchorRoomType, setAnchorRoomType] = useState<string>(
    initial.anchorRoomType ?? ANCHOR_ROOM_OPTIONS[0]
  );

  const firstInputRef = useRef<HTMLInputElement>(null);

  // Auto-focus the first empty field on mount
  useEffect(() => {
    firstInputRef.current?.focus();
  }, []);

  const parsed = {
    masterCeilingHeight: parsePositive(drafts.masterCeilingHeight),
    mainRoomWidth: parsePositive(drafts.mainRoomWidth),
    mainRoomLength: parsePositive(drafts.mainRoomLength),
  };

  const allValid =
    parsed.masterCeilingHeight != null &&
    parsed.mainRoomWidth != null &&
    parsed.mainRoomLength != null;

  function handleChange(key: DraftKey, value: string) {
    setDrafts((d) => ({ ...d, [key]: value }));
    // Clear error as the user types
    if (errors[key]) setErrors((e) => ({ ...e, [key]: false }));
  }

  function handleBlur(key: DraftKey) {
    if (drafts[key] !== "" && parsePositive(drafts[key]) == null) {
      setErrors((e) => ({ ...e, [key]: true }));
    }
  }

  function handleConfirm() {
    // Mark all invalid fields as errored
    const newErrors: Record<DraftKey, boolean> = {
      masterCeilingHeight: parsed.masterCeilingHeight == null,
      mainRoomWidth: parsed.mainRoomWidth == null,
      mainRoomLength: parsed.mainRoomLength == null,
    };
    setErrors(newErrors);
    if (!allValid) return;

    onConfirm({
      masterCeilingHeight: parsed.masterCeilingHeight!,
      mainRoomWidth: parsed.mainRoomWidth!,
      mainRoomLength: parsed.mainRoomLength!,
      anchorRoomType,
    });
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && allValid) handleConfirm();
    if (e.key === "Escape") onCancel();
  }

  const scanLabel = scanType === "deep" ? "Start 360° Scan" : "Start Scan";

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-[700] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="flex w-[22rem] flex-col gap-5 rounded-2xl border border-white/15 bg-black/85 p-6 shadow-2xl shadow-black/70 backdrop-blur-md mb-[22rem]">
        {/* ── Header ── */}
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-white/40">
              Pre-Scan Calibration
            </p>
            <p className="mt-1 text-lg font-bold tracking-tight text-white">
              Room Measurements
            </p>
            <p className="mt-0.5 text-[11px] leading-snug text-white/45">
              Enter tape-measured values so the 3D model is born with correct
              scale.
            </p>
          </div>
          <button
            onClick={onCancel}
            className="mt-0.5 shrink-0 rounded-md px-2 py-1 text-[10px] font-medium text-white/30 transition-colors hover:bg-white/10 hover:text-white/60"
          >
            Cancel
          </button>
        </div>

        {/* ── Anchor Room Selector ── */}
        <div className="flex flex-col gap-1">
          <label className="flex items-center justify-between text-[11px] font-medium text-white/70">
            <span>Anchor Room</span>
            <span className="font-normal text-white/35">width reference</span>
          </label>
          <select
            value={anchorRoomType}
            onChange={(e) => setAnchorRoomType(e.target.value)}
            className="w-full rounded-xl border border-white/15 bg-white/8 px-3 py-2.5 text-sm text-white outline-none transition-colors focus:border-sky-400/60 focus:ring-1 focus:ring-sky-500/20"
          >
            {ANCHOR_ROOM_OPTIONS.map((opt) => (
              <option
                key={opt}
                value={opt}
                className="bg-neutral-900 text-white"
              >
                {opt}
              </option>
            ))}
          </select>
          <p className="text-[10px] text-white/30">
            Which room does your width measurement apply to?
          </p>
        </div>

        {/* ── Fields ── */}
        <div className="flex flex-col gap-3">
          {FIELD_META.map(({ key, label, hint, placeholder }, i) => {
            const hasError = errors[key];
            return (
              <div key={key} className="flex flex-col gap-1">
                <label className="flex items-center justify-between text-[11px] font-medium text-white/70">
                  <span>{label}</span>
                  <span className="font-normal text-white/35">
                    metres or ft/in
                  </span>
                </label>
                <input
                  ref={i === 0 ? firstInputRef : undefined}
                  type="text"
                  inputMode="decimal"
                  value={drafts[key]}
                  onChange={(e) => handleChange(key, e.target.value)}
                  onBlur={() => handleBlur(key)}
                  onKeyDown={handleKeyDown}
                  placeholder={placeholder}
                  className={`w-full rounded-xl border px-3 py-2.5 text-sm text-white outline-none transition-colors placeholder:text-white/25 focus:ring-1 ${
                    hasError
                      ? "border-red-500/60 bg-red-500/10 focus:border-red-400 focus:ring-red-500/30"
                      : "border-white/15 bg-white/8 focus:border-sky-400/60 focus:ring-sky-500/20"
                  }`}
                />
                {hasError ? (
                  <p className="text-[10px] text-red-400">
                    Enter a value in metres (e.g. 2.40) or ft/in (e.g. 8ft 2in).
                  </p>
                ) : parsed[key] != null &&
                  drafts[key].trim() &&
                  !/^\d*\.?\d*\s*m?$/.test(drafts[key].trim().toLowerCase()) ? (
                  <p className="text-[10px] text-sky-400/70">
                    ≈ {parsed[key]!.toFixed(2)} m
                  </p>
                ) : (
                  <p className="text-[10px] text-white/30">{hint}</p>
                )}
              </div>
            );
          })}
        </div>

        {/* ── Completeness indicator ── */}
        <div className="flex items-center gap-1.5">
          {(
            [
              "masterCeilingHeight",
              "mainRoomWidth",
              "mainRoomLength",
            ] as DraftKey[]
          ).map((key) => (
            <div
              key={key}
              className={`h-1 flex-1 rounded-full transition-colors duration-200 ${
                parsed[key] != null ? "bg-sky-400" : "bg-white/15"
              }`}
            />
          ))}
        </div>

        {/* ── Action button ── */}
        <button
          onClick={handleConfirm}
          disabled={!allValid}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-sky-500 py-2.5 text-sm font-semibold text-white shadow-sm shadow-sky-900/50 transition-colors hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-35"
        >
          {allValid && (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-4 w-4"
            >
              <path d="M10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" />
              <path
                fillRule="evenodd"
                d="M.664 10.59a1.651 1.651 0 010-1.186A10.004 10.004 0 0110 3c4.257 0 7.893 2.66 9.336 6.41.147.381.146.804 0 1.186A10.004 10.004 0 0110 17c-4.257 0-7.893-2.66-9.336-6.41z"
                clipRule="evenodd"
              />
            </svg>
          )}
          {scanLabel}
        </button>
      </div>
    </div>
  );
}
