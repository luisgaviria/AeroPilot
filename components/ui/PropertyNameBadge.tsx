"use client";

import { useState } from "react";
import { useAeroStore } from "@/store/useAeroStore";
import { supabase } from "@/lib/supabase";

export function PropertyNameBadge() {
  const currentRoomName    = useAeroStore((s) => s.currentRoomName);
  const currentRoomId      = useAeroStore((s) => s.currentRoomId);
  const setCurrentRoomName = useAeroStore((s) => s.setCurrentRoomName);
  const saveCurrentRoom    = useAeroStore((s) => s.saveCurrentRoom);

  const [editing, setEditing] = useState(false);
  const [draft,   setDraft]   = useState("");

  const displayName = currentRoomName ?? "Unnamed Property";

  function startEdit() {
    setDraft(currentRoomName ?? "");
    setEditing(true);
  }

  async function commit() {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== currentRoomName) {
      setCurrentRoomName(trimmed);
      if (currentRoomId) {
        // Sync rename to existing Supabase row
        const { error } = await supabase
          .from("rooms")
          .update({ name: trimmed })
          .eq("id", currentRoomId);
        if (error) console.error("[Persistence] Rename failed:", error.message);
      } else {
        // No row yet — full save creates it with the new name
        await saveCurrentRoom().catch((err) =>
          console.error("[Persistence] Save on rename failed:", err)
        );
      }
    }
    setEditing(false);
  }

  return (
    <div className="flex items-center gap-1">
      {editing ? (
        <input
          autoFocus
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
          className="w-44 rounded border border-amber-400/40 bg-black/50 px-2 py-0.5 text-[11px] text-amber-300 outline-none placeholder-white/20 focus:border-amber-400/70"
          placeholder="Property name…"
        />
      ) : (
        <button
          onClick={startEdit}
          title="Rename property"
          className="group flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] text-white/35 transition-colors hover:bg-white/8 hover:text-white/65"
        >
          <span>{displayName}</span>
          {/* Pencil icon — visible on hover */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 16 16"
            fill="currentColor"
            className="h-2.5 w-2.5 opacity-0 transition-opacity group-hover:opacity-100"
          >
            <path d="M13.488 2.513a1.75 1.75 0 0 0-2.475 0L6.75 6.774a2.75 2.75 0 0 0-.596.892l-.848 2.047a.75.75 0 0 0 .98.98l2.047-.848a2.75 2.75 0 0 0 .892-.596l4.263-4.263a1.75 1.75 0 0 0 0-2.474Z" />
            <path d="M4.75 3.5c-.69 0-1.25.56-1.25 1.25v6.5c0 .69.56 1.25 1.25 1.25h6.5c.69 0 1.25-.56 1.25-1.25V8.75a.75.75 0 0 1 1.5 0v2.5A2.75 2.75 0 0 1 11.25 14h-6.5A2.75 2.75 0 0 1 2 11.25v-6.5A2.75 2.75 0 0 1 4.75 2h2.5a.75.75 0 0 1 0 1.5h-2.5Z" />
          </svg>
        </button>
      )}
    </div>
  );
}
