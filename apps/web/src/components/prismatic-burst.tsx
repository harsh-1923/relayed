"use client";

// Adapted from React Bits PrismaticBurst, Copyright (c) 2026 David Haz.
// See prismatic-burst.LICENSE.md for the MIT + Commons Clause license.
import { useEffect, useRef, type CSSProperties } from "react";
import { Renderer, Program, Mesh, Triangle, Texture } from "ogl";
import "./prismatic-burst.css";

const vertexShader = `#version 300 es
in vec2 position;
in vec2 uv;
out vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = vec4(position, 0.0, 1.0);
}
`;

const fragmentShader = `#version 300 es
precision highp float;
precision highp int;

out vec4 fragColor;

uniform vec2  uResolution;
uniform float uTime;

uniform float uIntensity;
uniform float uSpeed;
uniform int   uAnimType;
uniform vec2  uMouse;
uniform int   uColorCount;
uniform float uDistort;
uniform vec2  uOffset;
uniform sampler2D uGradient;
uniform float uNoiseAmount;
uniform int   uRayCount;
uniform float uLightMode;

float hash21(vec2 p){
    p = floor(p);
    float f = 52.9829189 * fract(dot(p, vec2(0.065, 0.005)));
    return fract(f);
}

mat2 rot30(){ return mat2(0.8, -0.5, 0.5, 0.8); }

float layeredNoise(vec2 fragPx){
    vec2 p = mod(fragPx + vec2(uTime * 30.0, -uTime * 21.0), 1024.0);
    vec2 q = rot30() * p;
    float n = 0.0;
    n += 0.40 * hash21(q);
    n += 0.25 * hash21(q * 2.0 + 17.0);
    n += 0.20 * hash21(q * 4.0 + 47.0);
    n += 0.10 * hash21(q * 8.0 + 113.0);
    n += 0.05 * hash21(q * 16.0 + 191.0);
    return n;
}

vec3 rayDir(vec2 frag, vec2 res, vec2 offset, float dist){
    float focal = res.y * max(dist, 1e-3);
    return normalize(vec3(2.0 * (frag - offset) - res, focal));
}

float edgeFade(vec2 frag, vec2 res, vec2 offset){
    vec2 toC = frag - 0.5 * res - offset;
    float r = length(toC) / (0.5 * min(res.x, res.y));
    float x = clamp(r, 0.0, 1.0);
    float q = x * x * x * (x * (x * 6.0 - 15.0) + 10.0);
    float s = q * 0.5;
    s = pow(s, 1.5);
    float tail = 1.0 - pow(1.0 - s, 2.0);
    s = mix(s, tail, 0.2);
    float dn = (layeredNoise(frag * 0.15) - 0.5) * 0.0015 * s;
    return clamp(s + dn, 0.0, 1.0);
}

mat3 rotX(float a){ float c = cos(a), s = sin(a); return mat3(1.0,0.0,0.0, 0.0,c,-s, 0.0,s,c); }
mat3 rotY(float a){ float c = cos(a), s = sin(a); return mat3(c,0.0,s, 0.0,1.0,0.0, -s,0.0,c); }
mat3 rotZ(float a){ float c = cos(a), s = sin(a); return mat3(c,-s,0.0, s,c,0.0, 0.0,0.0,1.0); }

vec3 sampleGradient(float t){
    t = clamp(t, 0.0, 1.0);
    return texture(uGradient, vec2(t, 0.5)).rgb;
}

vec2 rot2(vec2 v, float a){
    float s = sin(a), c = cos(a);
    return mat2(c, -s, s, c) * v;
}

float bendAngle(vec3 q, float t){
    float a = 0.8 * sin(q.x * 0.55 + t * 0.6)
            + 0.7 * sin(q.y * 0.50 - t * 0.5)
            + 0.6 * sin(q.z * 0.60 + t * 0.7);
    return a;
}

void main(){
    vec2 frag = gl_FragCoord.xy;
    float t = uTime * uSpeed;
    float jitterAmp = 0.1 * clamp(uNoiseAmount, 0.0, 1.0);
    vec3 dir = rayDir(frag, uResolution, uOffset, 1.0);
    float marchT = 0.0;
    vec3 col = vec3(0.0);
    float n = layeredNoise(frag);
    vec4 c = cos(t * 0.2 + vec4(0.0, 33.0, 11.0, 0.0));
    mat2 M2 = mat2(c.x, c.y, c.z, c.w);
    float amp = clamp(uDistort, 0.0, 50.0) * 0.15;

    mat3 rot3dMat = mat3(1.0);
    if(uAnimType == 1){
      vec3 ang = vec3(t * 0.31, t * 0.21, t * 0.17);
      rot3dMat = rotZ(ang.z) * rotY(ang.y) * rotX(ang.x);
    }
    mat3 hoverMat = mat3(1.0);
    if(uAnimType == 2){
      vec2 m = uMouse * 2.0 - 1.0;
      vec3 ang = vec3(m.y * 0.6, m.x * 0.6, 0.0);
      hoverMat = rotY(ang.y) * rotX(ang.x);
    }

    for (int i = 0; i < 44; ++i) {
        vec3 P = marchT * dir;
        P.z -= 2.0;
        float rad = length(P);
        vec3 Pl = P * (10.0 / max(rad, 1e-6));

        if(uAnimType == 0){
            Pl.xz *= M2;
        } else if(uAnimType == 1){
      Pl = rot3dMat * Pl;
        } else {
      Pl = hoverMat * Pl;
        }

        float stepLen = min(rad - 0.3, n * jitterAmp) + 0.1;

        float grow = smoothstep(0.35, 3.0, marchT);
        float a1 = amp * grow * bendAngle(Pl * 0.6, t);
        float a2 = 0.5 * amp * grow * bendAngle(Pl.zyx * 0.5 + 3.1, t * 0.9);
        vec3 Pb = Pl;
        Pb.xz = rot2(Pb.xz, a1);
        Pb.xy = rot2(Pb.xy, a2);

        float rayPattern = smoothstep(
            0.5, 0.7,
            sin(Pb.x + cos(Pb.y) * cos(Pb.z)) *
            sin(Pb.z + sin(Pb.y) * cos(Pb.x + t))
        );

        if (uRayCount > 0) {
            float ang = atan(Pb.y, Pb.x);
            float comb = 0.5 + 0.5 * cos(float(uRayCount) * ang);
            comb = pow(comb, 3.0);
            rayPattern *= smoothstep(0.15, 0.95, comb);
        }

        vec3 spectralDefault = 1.0 + vec3(
            cos(marchT * 3.0 + 0.0),
            cos(marchT * 3.0 + 1.0),
            cos(marchT * 3.0 + 2.0)
        );

        float saw = fract(marchT * 0.25);
        float tRay = saw * saw * (3.0 - 2.0 * saw);
        vec3 userGradient = 2.0 * sampleGradient(tRay);
        vec3 spectral = (uColorCount > 0) ? userGradient : spectralDefault;
        vec3 base = (0.05 / (0.4 + stepLen))
                  * smoothstep(5.0, 0.0, rad)
                  * spectral;

        col += base * rayPattern;
        marchT += stepLen;
    }

    col *= edgeFade(frag, uResolution, uOffset);
    col *= uIntensity;

    col = clamp(col, 0.0, 1.0);
    if (uLightMode > 0.5) {
        float energy = max(max(col.r, col.g), col.b);
        vec3 hue = col / max(energy, 0.0001);
        float neutral = min(hue.r, min(hue.g, hue.b));
        hue = max(hue - vec3(neutral * 0.68), vec3(0.0));
        hue /= max(max(hue.r, max(hue.g, hue.b)), 0.0001);
        vec3 pigment = mix(hue, hue * hue, 0.24) * 0.64;
        float coverage = smoothstep(0.001, 0.32, energy);
        coverage = pow(coverage, 0.72) * 0.92;
        col = mix(vec3(1.0), pigment, coverage);
    }
    fragColor = vec4(col, 1.0);
}`;

export type PrismaticBurstProps = {
  intensity?: number;
  speed?: number;
  animationType?: "rotate" | "rotate3d" | "hover";
  colors?: readonly string[];
  distort?: number;
  paused?: boolean;
  offset?: { x?: number; y?: number };
  hoverDampness?: number;
  rayCount?: number;
  mixBlendMode?: CSSProperties["mixBlendMode"];
  lightMode?: boolean;
};

const DEFAULT_COLORS = ["#ff007a", "#4d3dff", "#ffffff"];

export default function PrismaticBurst({
  intensity = 2,
  speed = 0.5,
  animationType = "rotate3d",
  colors = DEFAULT_COLORS,
  distort = 1,
  paused = false,
  offset,
  hoverDampness = 0.25,
  rayCount = 24,
  mixBlendMode = "lighten",
  lightMode = false,
}: PrismaticBurstProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<((settings: Required<Omit<PrismaticBurstProps, "offset" | "mixBlendMode">> & {
    offsetX: number;
    offsetY: number;
  }) => void) | null>(null);
  const offsetX = offset?.x ?? 0;
  const offsetY = offset?.y ?? 0;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const canvas = document.createElement("canvas");
    // The supplied GLSL requires WebGL 2; keep the selected background if unavailable.
    const context = canvas.getContext("webgl2", { alpha: false, antialias: false });
    if (!context) return;

    const renderer = new Renderer({
      canvas,
      webgl: 2,
      dpr: Math.min(window.devicePixelRatio || 1, 1.5),
      alpha: false,
      antialias: false,
    });
    const gl = renderer.gl;
    const gradient = new Texture(gl, {
      image: new Uint8Array([255, 255, 255, 255]),
      width: 1,
      height: 1,
      generateMipmaps: false,
      flipY: false,
      minFilter: gl.LINEAR,
      magFilter: gl.LINEAR,
      wrapS: gl.CLAMP_TO_EDGE,
      wrapT: gl.CLAMP_TO_EDGE,
    });
    const uniforms = {
      uResolution: { value: [1, 1] },
      uTime: { value: 0 },
      uIntensity: { value: 2 },
      uSpeed: { value: 0.5 },
      uAnimType: { value: 1 },
      uMouse: { value: [0.5, 0.5] },
      uColorCount: { value: 0 },
      uDistort: { value: 1 },
      uOffset: { value: [0, 0] },
      uGradient: { value: gradient },
      uNoiseAmount: { value: 0.8 },
      uRayCount: { value: 24 },
      uLightMode: { value: 0 },
    };
    const program = new Program(gl, {
      vertex: vertexShader,
      fragment: fragmentShader,
      uniforms,
      depthTest: false,
      depthWrite: false,
    });
    if (!gl.getProgramParameter(program.program, gl.LINK_STATUS)) {
      program.remove();
      gl.deleteTexture(gradient.texture);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      return;
    }
    const geometry = new Triangle(gl);
    const mesh = new Mesh(gl, { geometry, program });
    container.appendChild(canvas);

    let animationFrame = 0;
    let lastTime = performance.now();
    let elapsed = 0;
    let isPaused = false;
    let isVisible = true;
    let contextLost = false;
    let pointerDampness = 0.25;
    let gradientKey = "";
    // DialKit accepts CSS colors, including RGB, HSL and OKLCH. Convert them
    // through the browser rather than silently misreading them as hex.
    const colorCanvas = document.createElement("canvas");
    colorCanvas.width = colorCanvas.height = 1;
    const colorContext = colorCanvas.getContext("2d");
    const pointerTarget = [0.5, 0.5];

    const draw = () => {
      if (!contextLost) renderer.render({ scene: mesh });
    };
    const update = (now: number) => {
      animationFrame = 0;
      const delta = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;
      elapsed += delta;
      uniforms.uTime.value = elapsed;
      const smoothing = 1 - Math.exp(-delta / (0.02 + Math.max(0, Math.min(1, pointerDampness)) * 0.5));
      uniforms.uMouse.value[0]! += (pointerTarget[0]! - uniforms.uMouse.value[0]!) * smoothing;
      uniforms.uMouse.value[1]! += (pointerTarget[1]! - uniforms.uMouse.value[1]!) * smoothing;
      draw();
      schedule();
    };
    const schedule = () => {
      cancelAnimationFrame(animationFrame);
      animationFrame = 0;
      if (isPaused || !isVisible || document.hidden || contextLost) return;
      lastTime = performance.now();
      animationFrame = requestAnimationFrame(update);
    };
    // Sliders update the existing shader so scrubbing never recreates a
    // WebGL context or restarts the animation's clock.
    settingsRef.current = (settings) => {
      uniforms.uIntensity.value = settings.intensity;
      uniforms.uSpeed.value = settings.speed;
      uniforms.uAnimType.value = { rotate: 0, rotate3d: 1, hover: 2 }[settings.animationType];
      uniforms.uDistort.value = settings.distort;
      uniforms.uRayCount.value = Math.max(0, Math.floor(settings.rayCount));
      uniforms.uOffset.value = [settings.offsetX * renderer.dpr, settings.offsetY * renderer.dpr];
      uniforms.uLightMode.value = settings.lightMode ? 1 : 0;
      pointerDampness = settings.hoverDampness;
      isPaused = settings.paused;
      const nextGradientKey = JSON.stringify(settings.colors);
      if (gradientKey !== nextGradientKey && colorContext) {
        gradientKey = nextGradientKey;
        const stops = settings.colors.length ? settings.colors.slice(0, 64) : ["#ffffff"];
        const pixels = new Uint8Array(stops.length * 4);
        stops.forEach((color, index) => {
          colorContext.clearRect(0, 0, 1, 1);
          colorContext.fillStyle = "#ffffff";
          colorContext.fillStyle = color;
          colorContext.fillRect(0, 0, 1, 1);
          pixels.set(colorContext.getImageData(0, 0, 1, 1).data, index * 4);
        });
        gradient.image = pixels;
        gradient.width = stops.length;
        gradient.needsUpdate = true;
        uniforms.uColorCount.value = settings.colors.length;
      }
      draw();
      schedule();
    };
    const resize = () => {
      renderer.setSize(Math.max(container.clientWidth, 1), Math.max(container.clientHeight, 1));
      uniforms.uResolution.value = [gl.drawingBufferWidth, gl.drawingBufferHeight];
      draw();
    };
    const onPointer = (event: PointerEvent) => {
      const bounds = container.getBoundingClientRect();
      pointerTarget[0] = Math.max(0, Math.min(1, (event.clientX - bounds.left) / Math.max(bounds.width, 1)));
      pointerTarget[1] = Math.max(0, Math.min(1, 1 - (event.clientY - bounds.top) / Math.max(bounds.height, 1)));
    };
    const onContextLost = () => {
      contextLost = true;
      canvas.style.visibility = "hidden";
      schedule();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      isVisible = entry?.isIntersecting ?? false;
      schedule();
    });
    intersectionObserver.observe(container);
    container.addEventListener("pointermove", onPointer, { passive: true });
    canvas.addEventListener("webglcontextlost", onContextLost);
    document.addEventListener("visibilitychange", schedule);
    resize();
    schedule();

    return () => {
      settingsRef.current = null;
      cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      container.removeEventListener("pointermove", onPointer);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      document.removeEventListener("visibilitychange", schedule);
      geometry.remove();
      program.remove();
      gl.deleteTexture(gradient.texture);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      canvas.remove();
    };
  }, []);

  useEffect(() => {
    settingsRef.current?.({ paused, intensity, speed, animationType, colors, distort, offsetX, offsetY, hoverDampness, rayCount, lightMode });
  }, [paused, intensity, speed, animationType, colors, distort, offsetX, offsetY, hoverDampness, rayCount, lightMode]);

  return <div ref={containerRef} className="prismatic-burst" style={{ mixBlendMode }} aria-hidden="true" />;
}
