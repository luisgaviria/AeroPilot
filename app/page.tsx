import { Scene } from "@/components/canvas/Scene";
import { StatusIndicator } from "@/components/ui/StatusIndicator";
import { ChatInput } from "@/components/ui/ChatInput";
import { TourOverlay } from "@/components/ui/TourOverlay";
import { DiagnosticDashboard } from "@/components/ui/DiagnosticDashboard";
import { RulerOverlay } from "@/components/ui/RulerOverlay";

export default function Home() {
  return (
    <main className="relative h-screen w-screen overflow-hidden bg-black">
      {/* Cinematic tour overlay — centred at bottom, above canvas UI */}
      <TourOverlay />

      {/* Reference Ruler prompt — appears when 2 floor points are placed */}
      <RulerOverlay />

      {/* Full-viewport 3D canvas */}
      <div className="absolute inset-0">
        <Scene />
      </div>

      {/* ── UI Overlay ── kept above drei <Html> labels via explicit z-index */}
      <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-6" style={{ zIndex: 100 }}>
        {/* Top bar — branding + status */}
        <div className="flex items-start justify-between">
          <div className="flex flex-col gap-3 pointer-events-auto">
            <div>
              <h1 className="text-xl font-bold tracking-tight text-white drop-shadow">
                Aero<span className="text-sky-400">Pilot</span>
              </h1>
              <p className="text-xs text-white/40">Autonomous Spatial Engine</p>
            </div>
            <DiagnosticDashboard />
          </div>
          <div className="pointer-events-auto">
            <StatusIndicator />
          </div>
        </div>

        {/* Bottom bar — chat only */}
        <div className="flex items-end justify-end">
          <div className="pointer-events-auto">
            <ChatInput />
          </div>
        </div>
      </div>
    </main>
  );
}
