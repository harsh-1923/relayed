"use client";

import Link from "next/link";
import { useEffect, useMemo, type CSSProperties } from "react";
import { DialRoot, DialStore, useDialKitController } from "dialkit";
import "dialkit/styles.css";
import { HailBackground } from "./hail-background";
import { createHailDialConfig } from "@/lib/hail-dial-config";
import { DEFAULT_HAIL_SETTINGS as BASE_SETTINGS, HAIL_PRESETS as STARTERS } from "@/lib/hail-presets";

const PANEL_ID = "hail-v2";

const DIAL_CONFIG = createHailDialConfig(BASE_SETTINGS);

export function HailTuner({ markContents }: { markContents: string }) {
  const { values, setValues, setValue } = useDialKitController(
    "Hail variations",
    DIAL_CONFIG,
    { id: PANEL_ID, persist: true },
  );

  useEffect(() => {
    // Seed once after DialKit has restored any saved versions. Create each
    // version before changing values so the previous version keeps its edits.
    if (DialStore.getPresets(PANEL_ID).length) return;
    let firstVersion = "";
    for (const starter of STARTERS) {
      const versionId = DialStore.savePreset(PANEL_ID, starter.name);
      setValues(starter.settings);
      firstVersion ||= versionId;
    }
    DialStore.loadPreset(PANEL_ID, firstVersion);
  }, [setValues]);

  const activeVersion = DialStore.getPresets(PANEL_ID).find(
    (version) => version.id === DialStore.getActivePresetId(PANEL_ID),
  );
  const colors = useMemo(
    () => [values.rays.colorOne, values.rays.colorTwo, values.rays.colorThree],
    [values.rays.colorOne, values.rays.colorTwo, values.rays.colorThree],
  );

  function selectStarter(starter: (typeof STARTERS)[number]) {
    const savedVersion = DialStore.getPresets(PANEL_ID).find((version) => version.name === starter.name);
    if (savedVersion) {
      DialStore.loadPreset(PANEL_ID, savedVersion.id);
    } else {
      DialStore.savePreset(PANEL_ID, starter.name);
      setValues(starter.settings);
    }
  }

  return (
    <main className="min-h-dvh bg-[#101114] text-[#eeefef]">
      <header className="flex min-h-20 flex-wrap items-center justify-between gap-4 border-b border-white/10 px-6 py-5">
        <div className="flex items-center gap-4">
          <span className="text-lg font-semibold tracking-[-0.04em]">HAIL</span>
          <span className="h-4 w-px bg-white/20" />
          <h1 className="text-xs font-medium tracking-[0.14em] text-white/60 uppercase">Color & motion studies</h1>
        </div>
        <Link href="/hail" className="rounded-sm text-xs text-white/65 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-4">
          Original logo ↗
        </Link>
      </header>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          <section
            aria-label="Live logo preview"
            className="relative isolate grid h-[calc(100svh-280px)] min-h-[420px] place-items-center overflow-hidden"
            style={{ backgroundColor: values.palette.background, color: values.palette.logo }}
          >
            {values.motion.enabled ? (
              <div className="absolute inset-0" style={{ opacity: values.rays.opacity, mixBlendMode: values.rays.blend as CSSProperties["mixBlendMode"] }}>
                <HailBackground
                  colors={colors}
                  intensity={values.rays.intensity}
                  rayCount={values.rays.count}
                  distort={values.rays.distortion}
                  speed={values.motion.speed}
                  animationType={values.motion.type as "rotate3d" | "rotate" | "hover"}
                  paused={values.motion.paused}
                  lightMode={values.rays.lightMode}
                  mixBlendMode="normal"
                />
              </div>
            ) : null}
            <div className="pointer-events-none absolute top-6 left-6 z-10 text-xs opacity-60">
              {activeVersion?.name ?? "Version 1"}
            </div>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 221 226"
              fill="none"
              role="img"
              aria-label="Human Agent Interaction Labs"
              className="pointer-events-none relative z-10 h-auto max-w-[65%]"
              style={{ width: `min(${values.logo.size}px, 50svh)` }}
              dangerouslySetInnerHTML={{ __html: markContents }}
            />
            <button
              type="button"
              onClick={() => setValue("motion.paused", !values.motion.paused)}
              className="absolute right-6 bottom-6 z-10 rounded-full border border-current/25 px-4 py-2 text-xs opacity-70 hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-4"
            >
              {values.motion.paused ? "Resume animation" : "Pause animation"}
            </button>
          </section>

          <section aria-label="Starting palettes" className="border-t border-white/10 p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-[11px] font-medium tracking-[0.12em] text-white/60 uppercase">Six starting points</h2>
              <p className="text-[11px] text-white/40">Edits stay with each version</p>
            </div>
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
              {STARTERS.map((starter) => (
                <button
                  key={starter.name}
                  type="button"
                  onClick={() => selectStarter(starter)}
                  aria-pressed={activeVersion?.name === starter.name}
                  aria-label={starter.name}
                  className="group min-w-0 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white"
                >
                  <div
                    className="relative grid h-20 place-items-center overflow-hidden rounded-lg border border-white/10 transition-shadow group-hover:ring-1 group-hover:ring-white/50 group-aria-pressed:ring-2 group-aria-pressed:ring-white"
                    style={{ backgroundColor: starter.settings.palette.background, color: starter.settings.palette.logo }}
                  >
                    <div
                      className="absolute inset-0 opacity-35"
                      style={{ background: `radial-gradient(ellipse at 15% 100%, ${starter.settings.rays.colorOne}, transparent 65%), radial-gradient(ellipse at 95% 0%, ${starter.settings.rays.colorTwo}, transparent 65%)` }}
                    />
                    <svg
                      viewBox="0 0 221 226"
                      fill="none"
                      aria-hidden="true"
                      className="relative size-12"
                      dangerouslySetInnerHTML={{ __html: markContents }}
                    />
                  </div>
                  <span className="mt-2 block text-xs font-medium text-white/85">{starter.name}</span>
                  <span className="mt-1 block truncate text-[10px] text-white/40">{starter.note}</span>
                </button>
              ))}
            </div>
          </section>
        </div>

        <aside className="border-t border-white/10 bg-[#17181c] p-4 lg:h-[calc(100dvh-80px)] lg:overflow-y-auto lg:border-t-0 lg:border-l" aria-label="Variation controls">
          <div className="px-2 pt-2 pb-5">
            <h2 className="text-sm font-medium">Make it yours</h2>
            <p className="mt-2 text-xs leading-relaxed text-white/45">
              Tune a palette, or choose New version in the version menu to keep another direction.
              Changes save in this browser. Copy exports your settings.
            </p>
          </div>
          <DialRoot mode="inline" theme="dark" productionEnabled />
        </aside>
      </div>
    </main>
  );
}
