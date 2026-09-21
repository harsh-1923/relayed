"use client";

import { DialRoot, useDialKit } from "dialkit";
import "dialkit/styles.css";

import { DEFAULT_STRIP_SETTINGS, HeroStrips, type StripSettings } from "@/components/hero-strips";

// The hero with a live control panel over it. `HeroStrips` itself stays
// prop-driven and knows nothing about DialKit, so shipping the untuned hero is a
// matter of rendering it directly — which also takes DialKit out of the page
// bundle, since a hook that runs cannot be tree-shaken away.
//
// `DialRoot` hides itself in production builds unless passed `productionEnabled`,
// so the panel costs the deployed site nothing but its own weight.

// Slider tuples are [default, min, max, step]. Defaults come from the component
// rather than being retyped here, so the panel always opens showing what the
// hero actually renders.
const defaults = DEFAULT_STRIP_SETTINGS;

export function HeroStripsTuner() {
  const values = useDialKit(
    "Strips",
    {
      thickness: [defaults.thickness, 16, 200, 1],
      length: [defaults.length, 160, 1200, 10],
      columnGap: [defaults.columnGap, 40, 400, 2],
      cornerRadius: [defaults.cornerRadius, 0, 40, 1],
      text: {
        size: [defaults.textSize, 8, 40, 1],
        tracking: [defaults.textTracking, 0, 12, 0.1],
        align: { type: "select", options: ["end", "center", "start", "justify"] },
      },
      drag: {
        scale: [defaults.dragScale, 1, 1.5, 0.01],
        elastic: [defaults.dragElastic, 0, 1, 0.01],
        momentum: defaults.dragMomentum,
        popOffTheStack: defaults.popOnDrag,
      },
      rotate: {
        handleSize: [defaults.rotateHandleSize, 16, 200, 2],
        snapDegrees: [defaults.rotateSnap, 0, 45, 1],
        showHandles: defaults.showRotateHandles,
      },
    },
    { id: "strips", persist: true },
  );

  const settings: StripSettings = {
    thickness: values.thickness,
    length: values.length,
    columnGap: values.columnGap,
    cornerRadius: values.cornerRadius,
    textSize: values.text.size,
    textTracking: values.text.tracking,
    // The select control is typed as a plain string; these are its only options.
    textAlign: values.text.align as StripSettings["textAlign"],
    dragScale: values.drag.scale,
    dragElastic: values.drag.elastic,
    dragMomentum: values.drag.momentum,
    popOnDrag: values.drag.popOffTheStack,
    rotateHandleSize: values.rotate.handleSize,
    rotateSnap: values.rotate.snapDegrees,
    showRotateHandles: values.rotate.showHandles,
  };

  return (
    <>
      <HeroStrips settings={settings} />
      <DialRoot position="top-right" />
    </>
  );
}
