"use client";

import dynamic from "next/dynamic";
import { useSyncExternalStore } from "react";
import type { PrismaticBurstProps } from "./prismatic-burst";

const PrismaticBurst = dynamic(() => import("./prismatic-burst"), { ssr: false });
const MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeToMotionPreference(onChange: () => void) {
  const preference = window.matchMedia(MOTION_QUERY);
  preference.addEventListener("change", onChange);
  return () => preference.removeEventListener("change", onChange);
}

function getReducedMotion() {
  return window.matchMedia(MOTION_QUERY).matches;
}

function getServerReducedMotion() {
  return true;
}

export function HailBackground(props: PrismaticBurstProps) {
  const reducedMotion = useSyncExternalStore(
    subscribeToMotionPreference,
    getReducedMotion,
    getServerReducedMotion,
  );

  if (reducedMotion) return null;

  return <PrismaticBurst {...props} />;
}
