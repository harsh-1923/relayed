import { FRAG, VERT, TRAIL_N } from './retro-dither-shaders';

// Defaults from the supplied Canvas UI demo, applied only to the footer photo.
const SETTINGS = {
  uPixelSize: 2,
  uLevels: 4,
  uRadius: 0.5,
  uSoftness: 1,
  uColorize: 0.1,
  uContrast: 0.6,
  uBrightness: 0,
  uStrength: 0.75,
  uBase: 0,
  uInvert: 0,
  uScanlines: 0,
  uMaxX: 1,
};

export function createImageDither(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  host: HTMLElement,
): (() => void) | null {
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
  });
  if (!gl || gl.isContextLost()) return null;

  const shaders: WebGLShader[] = [];
  const program = gl.createProgram();
  const buffer = gl.createBuffer();
  const texture = gl.createTexture();
  function releaseResources() {
    gl!.deleteTexture(texture);
    gl!.deleteBuffer(buffer);
    gl!.deleteProgram(program);
    for (const shader of shaders) gl!.deleteShader(shader);
  }
  function compile(type: number, source: string) {
    const shader = gl!.createShader(type);
    if (!shader) throw new Error('Shader unavailable');
    shaders.push(shader);
    gl!.shaderSource(shader, source);
    gl!.compileShader(shader);
    if (!gl!.getShaderParameter(shader, gl!.COMPILE_STATUS)) {
      throw new Error('Shader compilation failed');
    }
    return shader;
  }

  try {
    if (!program || !buffer || !texture) throw new Error('WebGL resources unavailable');
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Shader linking failed');
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    if (gl.getError() !== gl.NO_ERROR) throw new Error('Image upload failed');
  } catch {
    releaseResources();
    return null;
  }

  const uniforms = new Map<string, WebGLUniformLocation | null>();
  function uniform(name: string) {
    if (!uniforms.has(name)) uniforms.set(name, gl!.getUniformLocation(program!, name));
    return uniforms.get(name)!;
  }
  for (const [name, value] of Object.entries(SETTINGS)) gl.uniform1f(uniform(name), value);
  gl.uniform1i(uniform('uContent'), 0);
  gl.uniform1i(uniform('uPattern'), 0);
  gl.uniform3f(uniform('uDark'), 0, 0, 0);
  gl.uniform3f(uniform('uLight'), 1, 1, 1);

  const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
  const pointer = { x: 0.5, y: 0.5, targetX: 0.5, targetY: 0.5, active: 0, target: 0 };
  type Point = { x: number; y: number; time: number };
  const trail: Point[] = [];
  const trailData = new Float32Array(TRAIL_N * 3);
  let lastTrail: Point | undefined;
  let frameId = 0;
  let lastTime = 0;
  let visible = false;
  let disposed = false;
  let contextLost = false;

  function hide() {
    cancelAnimationFrame(frameId);
    frameId = 0;
    canvas.style.visibility = 'hidden';
    pointer.active = 0;
    pointer.target = 0;
    trail.length = 0;
    lastTrail = undefined;
  }

  function wake() {
    if (
      frameId ||
      disposed ||
      contextLost ||
      !visible ||
      document.hidden ||
      motionPreference.matches
    )
      return;
    lastTime = performance.now();
    frameId = requestAnimationFrame(frame);
  }

  function frame(now: number) {
    frameId = 0;
    if (disposed || contextLost || !visible || document.hidden || motionPreference.matches) return;
    const delta = Math.min((now - lastTime) / 1000, 1 / 30);
    lastTime = now;
    const ease = 1 - Math.exp(-delta * 3);
    pointer.x += (pointer.targetX - pointer.x) * ease;
    pointer.y += (pointer.targetY - pointer.y) * ease;
    pointer.active += (pointer.target - pointer.active) * ease;
    const seconds = now / 1000;

    // A stationary cursor must settle rather than continuously spawning trails.
    if (
      pointer.active > 0.1 &&
      (!lastTrail ||
        (seconds - lastTrail.time >= 0.04 &&
          Math.hypot(pointer.x - lastTrail.x, pointer.y - lastTrail.y) > 0.002))
    ) {
      lastTrail = { x: pointer.x, y: pointer.y, time: seconds };
      trail.push(lastTrail);
      if (trail.length > TRAIL_N) trail.shift();
    }
    while (trail[0] && seconds - trail[0].time > 0.95) trail.shift();
    trailData.fill(0);
    trail.forEach((point, index) => {
      const age = seconds - point.time;
      const fade = Math.min(Math.max((0.95 - age) / 0.25, 0), 1);
      trailData.set([point.x, point.y, 0.4 * Math.exp(-age * 2.2) * fade], index * 3);
    });

    gl!.uniform2f(uniform('uPointer'), pointer.x, pointer.y);
    gl!.uniform1f(uniform('uActive'), pointer.active);
    gl!.uniform3fv(uniform('uTrail[0]'), trailData);
    gl!.drawArrays(gl!.TRIANGLE_STRIP, 0, 4);
    canvas.style.visibility =
      pointer.active > 0.001 || trail.length ? 'visible' : 'hidden';

    const moving =
      Math.abs(pointer.targetX - pointer.x) > 0.0005 ||
      Math.abs(pointer.targetY - pointer.y) > 0.0005 ||
      Math.abs(pointer.target - pointer.active) > 0.001;
    if (moving || trail.length) frameId = requestAnimationFrame(frame);
  }

  function resize() {
    if (contextLost) return;
    const bounds = canvas.getBoundingClientRect();
    // Capped at 1.5 to match the hero (prismatic-burst.tsx). At 2 this canvas
    // carried ~1.8x the hero's pixels for a decorative effect, and it renders on
    // pointermove — so sweeping the cursor across the footer drove a full-screen
    // shader at that size continuously.
    const density = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.max(1, Math.round(bounds.width * density));
    canvas.height = Math.max(1, Math.round(bounds.height * density));
    const containerAspect = canvas.width / canvas.height;
    const imageAspect = image.naturalWidth / image.naturalHeight;
    // Match the underlying Next Image's object-cover crop exactly.
    gl!.uniform2f(
      uniform('uImageScale'),
      Math.min(containerAspect / imageAspect, 1),
      Math.min(imageAspect / containerAspect, 1),
    );
    gl!.uniform2f(uniform('uResolution'), canvas.width, canvas.height);
    gl!.uniform1f(uniform('uPixelSize'), SETTINGS.uPixelSize * density);
    gl!.viewport(0, 0, canvas.width, canvas.height);
    wake();
  }

  function coordinates(event: PointerEvent) {
    const bounds = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - bounds.left) / Math.max(bounds.width, 1),
      y: 1 - (event.clientY - bounds.top) / Math.max(bounds.height, 1),
    };
  }
  function onMove(event: PointerEvent) {
    if (event.pointerType === 'touch' || motionPreference.matches) return;
    const point = coordinates(event);
    if (pointer.target === 1 && point.x === pointer.targetX && point.y === pointer.targetY) return;
    pointer.targetX = point.x;
    pointer.targetY = point.y;
    if (!pointer.active) {
      pointer.x = point.x;
      pointer.y = point.y;
    }
    pointer.target = 1;
    wake();
  }
  function onLeave() {
    pointer.target = 0;
    wake();
  }
  function onVisibility() {
    if (document.hidden) hide();
  }
  function onMotionChange() {
    if (motionPreference.matches) hide();
  }
  function onContextLost() {
    contextLost = true;
    hide();
  }
  function onImageLoad() {
    if (contextLost) return;
    try {
      gl!.bindTexture(gl!.TEXTURE_2D, texture);
      gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, gl!.RGBA, gl!.UNSIGNED_BYTE, image);
      resize();
    } catch {
      onContextLost();
    }
  }

  const sizeObserver = new ResizeObserver(resize);
  sizeObserver.observe(host);
  const visibilityObserver = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? false;
    if (!visible) hide();
  });
  visibilityObserver.observe(host);
  host.addEventListener('pointermove', onMove, { passive: true });
  host.addEventListener('pointerleave', onLeave, { passive: true });
  image.addEventListener('load', onImageLoad);
  document.addEventListener('visibilitychange', onVisibility);
  motionPreference.addEventListener('change', onMotionChange);
  canvas.addEventListener('webglcontextlost', onContextLost);
  resize();

  return () => {
    disposed = true;
    hide();
    sizeObserver.disconnect();
    visibilityObserver.disconnect();
    host.removeEventListener('pointermove', onMove);
    host.removeEventListener('pointerleave', onLeave);
    image.removeEventListener('load', onImageLoad);
    document.removeEventListener('visibilitychange', onVisibility);
    motionPreference.removeEventListener('change', onMotionChange);
    canvas.removeEventListener('webglcontextlost', onContextLost);
    releaseResources();
  };
}
