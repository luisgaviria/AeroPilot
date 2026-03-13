import { Scene } from "@/components/canvas/Scene";
import { StatusIndicator } from "@/components/ui/StatusIndicator";
import { ChatInput } from "@/components/ui/ChatInput";
import { NavigationBar } from "@/components/ui/NavigationBar";

export default function Home() {
  return (
    <main className="relative h-screen w-screen overflow-hidden bg-black">
      {/* Full-viewport 3D canvas */}
      <div className="absolute inset-0">
        <Scene />
      </div>

      {/* ── UI Overlay ── kept above drei <Html> labels via explicit z-index */}
      <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-6" style={{ zIndex: 100 }}>
        {/* Top bar — branding + status */}
        <div className="flex items-start justify-between">
          <div className="pointer-events-auto">
            <h1 className="text-xl font-bold tracking-tight text-white drop-shadow">
              Aero<span className="text-sky-400">Pilot</span>
            </h1>
            <p className="text-xs text-white/40">Spatial AI Real Estate Tour</p>
          </div>
          <div className="pointer-events-auto">
            <StatusIndicator />
          </div>
        </div>

        {/* Bottom bar — navigation + chat */}
        <div className="flex items-end justify-between">
          <div className="pointer-events-auto">
            <NavigationBar />
          </div>
          <div className="pointer-events-auto">
            <ChatInput />
          </div>
        </div>
      </div>
    </main>
  );
}
