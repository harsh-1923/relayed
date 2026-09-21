"use client";

import { useRef, useState } from "react";
import { motion, useDragControls, useMotionValue } from "motion/react";

// The effect the reference image turns on: where two strips overlap, multiply
// blending darkens the result, so the crossing point reads as a third colour
// rather than as whichever strip happens to be on top. It only works against a
// light backdrop, which is why the section paints one and isolates itself —
// without `isolate` the strips would blend with whatever sits behind the hero.
//
// Black text survives it untouched: black multiplied by anything is black. That
// is why the labels stay legible over every crossing, as they do in the
// reference.

export type StripSettings = {
  thickness: number;
  length: number;
  /** Distance between the vertical strips in the resting row. */
  columnGap: number;
  cornerRadius: number;
  textSize: number;
  textTracking: number;
  /** "end" is the strip's outer tip — the pivot end is where every label would pile up. */
  textAlign: "start" | "center" | "end" | "justify";
  dragScale: number;
  dragElastic: number;
  dragMomentum: boolean;
  /** While dragging, drop the blend and add a shadow so the strip lifts off the stack. */
  popOnDrag: boolean;
  /** Width of the grab zone at each tip that rotates instead of moves. */
  rotateHandleSize: number;
  /** Degrees to snap rotation to. 0 rotates freely. */
  rotateSnap: number;
  /** Tint the rotate zones so they can be seen while tuning. */
  showRotateHandles: boolean;
};

export const DEFAULT_STRIP_SETTINGS: StripSettings = {
  thickness: 62,
  length: 460,
  columnGap: 150,
  cornerRadius: 0,
  textSize: 14,
  textTracking: 1.5,
  textAlign: "end",
  dragScale: 1.03,
  dragElastic: 0.12,
  dragMomentum: false,
  popOnDrag: true,
  rotateHandleSize: 64,
  rotateSnap: 0,
  showRotateHandles: false,
};

// Sampled from the reference image rather than picked. The gray earns its place
// under multiply: it darkens a crossing without tinting it, which is what gives
// the reference its depth. Six maximally separated hues plus that neutral — the
// pastels and the two near-neighbours (crimson beside the coral, purple beside
// the magenta) are the ones that went.
const STRIPS = [
  { label: "LOCAL FIRST", color: "#F15A3C" },
  { label: "ORDERED LOG", color: "#F6B819" },
  { label: "SPACES", color: "#06BC9B" },
  { label: "AGENTS", color: "#1449E6" },
  { label: "OFFLINE READS", color: "#E437C6" },
  { label: "ONE PARTICIPANT", color: "#B3B3B3" },
] as const;

// Every strip stands upright at rest. Rotation is what a person changes, so it
// is a starting value rather than per-strip data.
const INITIAL_ANGLE = 90;

type Strip = (typeof STRIPS)[number];

// The resting arrangement: upright strips laid out in an evenly spaced row,
// centred on the section. Nothing overlaps until something is moved, so the
// multiply effect is something a person discovers by dragging rather than
// something they are shown.
function startingOffset(index: number, count: number, columnGap: number) {
  const fromCentre = index - (count - 1) / 2;
  // Rounded, and not for tidiness: motion serialises the prerendered transform
  // to six significant figures while the hydrating client writes the full
  // double, so `89.6635px` on the server meets `89.663501252087px` on the
  // client and React reports a hydration mismatch. Two decimals is below one
  // device pixel and identical on both sides.
  return { x: round(fromCentre * columnGap), y: 0 };
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

export function HeroStrips({ settings = DEFAULT_STRIP_SETTINGS }: { settings?: StripSettings }) {
  const container = useRef<HTMLDivElement>(null);

  return (
    <section
      ref={container}
      className="relative isolate h-svh w-full shrink-0 overflow-hidden bg-[#f3f3f3]"
    >
      {STRIPS.map((strip, index) => (
        <StripElement
          key={strip.label}
          strip={strip}
          index={index}
          settings={settings}
          container={container}
        />
      ))}
    </section>
  );
}

function StripElement({
  strip,
  index,
  settings,
  container,
}: {
  strip: Strip;
  index: number;
  settings: StripSettings;
  container: React.RefObject<HTMLDivElement | null>;
}) {
  const element = useRef<HTMLDivElement>(null);
  const dragControls = useDragControls();
  const rotation = useMotionValue<number>(INITIAL_ANGLE);
  // Rotation is tracked unsnapped so that snapping quantises what is shown
  // without quantising what the pointer has actually accumulated — otherwise a
  // slow drag under a coarse snap would never build up enough to move a step.
  const gesture = useRef<{ pointerId: number; lastPointerAngle: number; raw: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const offset = startingOffset(index, STRIPS.length, settings.columnGap);
  const popped = isDragging && settings.popOnDrag;

  /** Angle of the pointer around the strip's centre, in degrees. */
  function pointerAngle(clientX: number, clientY: number) {
    const rect = element.current?.getBoundingClientRect();
    if (!rect) return 0;
    const centreX = rect.left + rect.width / 2;
    const centreY = rect.top + rect.height / 2;
    return (Math.atan2(clientY - centreY, clientX - centreX) * 180) / Math.PI;
  }

  function startRotate(event: React.PointerEvent<HTMLDivElement>) {
    // Stops the body's `onPointerDown` above from also starting a drag.
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = {
      pointerId: event.pointerId,
      lastPointerAngle: pointerAngle(event.clientX, event.clientY),
      raw: rotation.get(),
    };
  }

  function moveRotate(event: React.PointerEvent<HTMLDivElement>) {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;

    const angle = pointerAngle(event.clientX, event.clientY);
    // atan2 wraps at ±180. Fold each step back into that range, or crossing the
    // seam once would register as a full turn in the wrong direction.
    let step = angle - active.lastPointerAngle;
    if (step > 180) step -= 360;
    if (step < -180) step += 360;

    active.lastPointerAngle = angle;
    active.raw += step;

    rotation.set(
      settings.rotateSnap > 0
        ? Math.round(active.raw / settings.rotateSnap) * settings.rotateSnap
        : active.raw,
    );
  }

  function endRotate(event: React.PointerEvent<HTMLDivElement>) {
    if (gesture.current?.pointerId !== event.pointerId) return;
    gesture.current = null;
  }

  return (
    <motion.div
      ref={element}
      drag
      // The drag gesture is started by hand rather than by motion's own
      // listener. Motion attaches that listener natively on this element, while
      // the rotate handles below are React handlers delegated at the root — so a
      // handle's `stopPropagation` runs too late to stop it, and a tip would
      // both swing and slide. With `dragListener` off, the only thing that
      // starts a drag is the body's own React handler, which a handle can stop.
      dragListener={false}
      dragControls={dragControls}
      onPointerDown={(event) => dragControls.start(event)}
      dragConstraints={container}
      dragElastic={settings.dragElastic}
      dragMomentum={settings.dragMomentum}
      whileDrag={{ scale: settings.dragScale }}
      onDragStart={() => setIsDragging(true)}
      onDragEnd={() => setIsDragging(false)}
      // `initial` rather than `style` for the offsets: drag owns x and y once the
      // gesture starts, and a static style value would be reset on the next
      // render. Rotation is a motion value instead, because the rotate handles
      // write to it directly.
      initial={{ x: offset.x, y: offset.y }}
      style={{
        rotate: rotation,
        width: settings.length,
        height: settings.thickness,
        // Positioned from the centre and pulled back by half its own size, so
        // the offsets above are measured from the middle of the section rather
        // than from its top-left corner.
        marginLeft: -settings.length / 2,
        marginTop: -settings.thickness / 2,
        backgroundColor: strip.color,
        borderRadius: settings.cornerRadius,
        boxShadow: popped ? "0 18px 40px rgb(0 0 0 / 0.22)" : "none",
        zIndex: popped ? 1 : 0,
      }}
      className={`absolute top-1/2 left-1/2 flex cursor-grab items-center px-4 touch-none select-none active:cursor-grabbing ${popped ? "" : "mix-blend-multiply"}`}
    >
      <span
        className="w-full font-bold text-black uppercase"
        style={{
          fontSize: settings.textSize,
          letterSpacing: settings.textTracking,
          textAlign: settings.textAlign,
          // A single line ignores `text-align: justify` unless the last line is
          // told to justify too — which, on one line, is the line.
          textAlignLast: settings.textAlign === "justify" ? "justify" : "auto",
        }}
      >
        {strip.label}
      </span>

      {/* A zone at each tip that swings the strip around its centre instead of
          sliding it. Pulling an end to turn something and holding its middle to
          carry it is how the physical object would behave, so neither gesture
          needs a modifier key or a visible handle. */}
      {(["left", "right"] as const).map((side) => (
        <div
          key={side}
          onPointerDown={startRotate}
          onPointerMove={moveRotate}
          onPointerUp={endRotate}
          onPointerCancel={endRotate}
          style={{
            width: settings.rotateHandleSize,
            [side]: 0,
            backgroundColor: settings.showRotateHandles ? "rgb(0 0 0 / 0.16)" : "transparent",
          }}
          className="absolute inset-y-0 z-10 cursor-crosshair"
        />
      ))}
    </motion.div>
  );
}
