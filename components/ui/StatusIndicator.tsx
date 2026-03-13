"use client";

import { useAeroStore } from "@/store/useAeroStore";
import { locations } from "@/data/locations";

export function StatusIndicator() {
  const isMoving = useAeroStore((s) => s.isMoving);
  const targetLocation = useAeroStore((s) => s.targetLocation);

  const label = locations[targetLocation]?.label ?? targetLocation;

  return (
    <div className="flex items-center gap-2 rounded-xl bg-black/50 px-4 py-2 backdrop-blur-sm">
      {/* Pulse dot */}
      <span className="relative flex h-2.5 w-2.5">
        {isMoving && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-75" />
        )}
        <span
          className={`relative inline-flex h-2.5 w-2.5 rounded-full ${
            isMoving ? "bg-sky-400" : "bg-emerald-400"
          }`}
        />
      </span>

      <p className="text-sm font-medium text-white">
        {isMoving ? "Moving to" : "At"}{" "}
        <span className="font-semibold text-sky-300">{label}</span>
      </p>
    </div>
  );
}
