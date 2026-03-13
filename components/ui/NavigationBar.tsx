"use client";

import { locations } from "@/data/locations";
import { useAeroStore } from "@/store/useAeroStore";

export function NavigationBar() {
  // Select values individually to maintain stable references
  const targetLocation = useAeroStore((s) => s.targetLocation);
  const setTargetLocation = useAeroStore((s) => s.setTargetLocation);

  return (
    <nav className="flex gap-2 p-2 bg-black/20 backdrop-blur-md rounded-lg border border-white/10">
      {Object.values(locations).map((loc) => (
        <button
          key={loc.id}
          onClick={() => setTargetLocation(loc.id, loc.camera)}
          className={`px-4 py-2 rounded-md transition-all ${
            targetLocation === loc.id
              ? "bg-white text-black"
              : "bg-white/5 text-white hover:bg-white/10"
          }`}
        >
          {loc.label}
        </button>
      ))}
    </nav>
  );
}
