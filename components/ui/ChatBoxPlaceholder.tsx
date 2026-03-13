"use client";

export function ChatBoxPlaceholder() {
  return (
    <div className="flex w-80 flex-col gap-2 rounded-2xl border border-white/10 bg-black/50 p-4 backdrop-blur-sm">
      <p className="text-xs font-semibold uppercase tracking-widest text-white/40">
        AI Assistant
      </p>

      {/* Message area skeleton */}
      <div className="flex flex-1 flex-col gap-2 py-2">
        <div className="h-3 w-3/4 animate-pulse rounded-full bg-white/10" />
        <div className="h-3 w-1/2 animate-pulse rounded-full bg-white/10" />
      </div>

      {/* Input skeleton */}
      <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2">
        <span className="flex-1 text-sm text-white/30">
          Ask about this space…
        </span>
        <div className="h-5 w-5 animate-pulse rounded-full bg-white/10" />
      </div>
    </div>
  );
}
