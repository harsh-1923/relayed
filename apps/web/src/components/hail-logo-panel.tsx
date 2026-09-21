import type { CSSProperties, ReactNode } from "react";
import { HailBackground } from "./hail-background";
import type { DEFAULT_HAIL_SETTINGS } from "@/lib/hail-presets";

// Renders the preset it is handed and nothing else. There is deliberately no
// live-tuning controller here any more: DialKit made this a client component
// with state, shipped its runtime and panel to every visitor, and wrote to
// localStorage on each change. The presets in `hail-presets.ts` are where the
// look is chosen now, which is why this file has no hooks and stays on the
// server.
export function HailLogoPanel({
  children,
  markContents,
  settings,
}: {
  children: ReactNode;
  markContents: string;
  settings: typeof DEFAULT_HAIL_SETTINGS;
}) {
  const colors = [settings.rays.colorOne, settings.rays.colorTwo, settings.rays.colorThree];

  return (
    <div
      className="relative isolate min-h-svh w-full overflow-hidden"
      style={{ backgroundColor: settings.palette.background, color: settings.palette.logo }}
    >
      {settings.motion.enabled ? (
        <div
          className="absolute inset-0"
          style={{
            opacity: settings.rays.opacity,
            mixBlendMode: settings.rays.blend as CSSProperties["mixBlendMode"],
          }}
        >
          <HailBackground
            colors={colors}
            intensity={settings.rays.intensity}
            rayCount={settings.rays.count}
            distort={settings.rays.distortion}
            speed={settings.motion.speed}
            animationType={settings.motion.type as "rotate3d" | "rotate" | "hover"}
            paused={settings.motion.paused}
            lightMode={settings.rays.lightMode}
            mixBlendMode="normal"
          />
        </div>
      ) : null}

      <div className="relative z-10 min-h-svh w-full">
        <div className="absolute inset-0 grid place-items-center px-6 sm:px-10">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 221 226"
            fill="none"
            role="img"
            aria-label="Human Agent Interaction Labs"
            className="pointer-events-none h-auto max-w-[72vw]"
            style={{ width: `min(${settings.logo.size}px, 60svh)` }}
            dangerouslySetInnerHTML={{ __html: markContents }}
          />
        </div>

        <div className="absolute inset-x-0 bottom-0 mx-auto w-full max-w-[90rem] px-6 py-7 sm:px-10 sm:py-9 lg:px-16">
          {children}
        </div>
      </div>
    </div>
  );
}
