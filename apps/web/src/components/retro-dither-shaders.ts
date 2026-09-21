// Adapted from the Canvas UI Retro Dither source supplied for the footer.
// Sample the image texture directly; the wordmark remains ordinary HTML.
export const VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main () {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

export const TRAIL_N = 24;

export const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uContent;
uniform vec2 uResolution;
uniform float uPixelSize;
uniform float uLevels;
uniform float uRadius;
uniform float uSoftness;
uniform vec2 uPointer;
uniform float uActive;
uniform vec3 uDark;
uniform vec3 uLight;
uniform float uColorize;
uniform float uContrast;
uniform float uBrightness;
uniform float uStrength;
uniform float uBase;
uniform float uInvert;
uniform float uScanlines;
uniform float uMaxX;
uniform vec2 uImageScale;
uniform int uPattern;
uniform vec3 uTrail[${TRAIL_N}];

#define S(a, b, t) smoothstep(a, b, t)

float bayer (ivec2 p) {
  int b[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(b[(p.y % 4) * 4 + (p.x % 4)]) + 0.5) / 16.0;
}

float patternThreshold (ivec2 cell) {
  if (uPattern == 1) {
    vec2 p = vec2(cell % 4) - 1.5;
    return clamp(length(p) / 2.6, 0.03, 0.97);
  }
  if (uPattern == 2) {
    return fract(float(cell.x + cell.y) * 0.25 + 0.125);
  }
  if (uPattern == 3) {
    return fract(float(cell.x) * 0.25 + float(cell.y % 2) * 0.5 + 0.125);
  }
  return bayer(cell);
}

float ditherQuant (float v, ivec2 cell) {
  float x = v * uLevels;
  return floor(x + step(patternThreshold(cell), fract(x))) / uLevels;
}

void main () {
  vec2 uv = vUv;

  if (uv.x > uMaxX) {
    outColor = vec4(0.0);
    return;
  }

  float aspect = uResolution.x / uResolution.y;

  vec4 content = texture(uContent, (vec2(uv.x, 1.0 - uv.y) - 0.5) * uImageScale + 0.5);

  vec2 frag = uv * uResolution;
  vec2 cell = floor(frag / uPixelSize);
  vec2 cellUv = (cell + 0.5) * uPixelSize / uResolution;
  cellUv = clamp(cellUv, vec2(0.001), vec2(uMaxX - 0.002, 0.999));
  vec4 pixel = texture(uContent, (vec2(cellUv.x, 1.0 - cellUv.y) - 0.5) * uImageScale + 0.5);
  float rawLum = dot(pixel.rgb, vec3(0.299, 0.587, 0.114));

  float crisp = 0.0;

  float contrastAmt = mix(uContrast, max(uContrast, 0.5), crisp);
  float brightAmt = uBrightness * mix(1.0, 0.3, crisp);
  float lum = clamp((rawLum - 0.5) * contrastAmt + 0.5 + brightAmt, 0.0, 1.0);
  lum = mix(lum, 1.0 - lum, clamp(uInvert, 0.0, 1.0));
  float q = crisp > 0.5
    ? clamp(floor(lum * uLevels + 0.5) / uLevels, 0.0, 1.0)
    : ditherQuant(lum, ivec2(cell));

  vec3 palette = mix(uDark, uLight, q);
  vec3 keepHue = pixel.rgb * (q / max(lum, 0.001));
  vec3 dithered = mix(keepHue, palette, clamp(uColorize, 0.0, 1.0));
  float scanAmp = mix(0.45, 0.15, crisp);
  dithered *= 1.0 - uScanlines * scanAmp * mod(cell.y, 2.0);

  float dist = length((uv - uPointer) * vec2(aspect, 1.0));
  float radius = max(uRadius * uActive, 1e-4);
  float inner = radius * (1.0 - clamp(uSoftness, 0.0, 1.0));
  float lens = (1.0 - S(inner, radius, dist)) * uActive;

  float ghost = 0.0;
  for (int i = 0; i < ${TRAIL_N}; i++) {
    float amp = uTrail[i].z;
    if (amp <= 0.001) continue;
    float td = length((uv - uTrail[i].xy) * vec2(aspect, 1.0));
    float tr = max(uRadius * 0.8, 1e-4);
    ghost = max(ghost, (1.0 - S(tr * 0.2, tr, td)) * amp);
  }

  float mask = clamp(max(max(lens, ghost), clamp(uBase, 0.0, 1.0)), 0.0, 1.0)
    * clamp(uStrength, 0.0, 1.0);

  float apply = step(bayer(ivec2(cell)), mask);

  vec3 col = mix(content.rgb, dithered, apply);
  float alpha = mix(content.a, pixel.a, apply);
  outColor = vec4(col, alpha);
}`;
