import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Renderer, Program, Mesh, Color, Triangle, RenderTarget } from 'ogl';
import { clampDpr, loseGlContext, prefersReducedMotion, safeCallMethod } from './webglShared';

const MAX_STRANDS = 12;
const MAX_COLORS = 8;
const STATIC_FRAME_TIME = 1.2;
const MAX_DELTA_SECONDS = 0.05;

export interface StrandsProps {
  className?: string;
  style?: CSSProperties;
  dpr?: number;
  paused?: boolean;
  colors?: string[];
  count?: number;
  speed?: number;
  amplitude?: number;
  waviness?: number;
  thickness?: number;
  glow?: number;
  taper?: number;
  spread?: number;
  hueShift?: number;
  intensity?: number;
  saturation?: number;
  opacity?: number;
  scale?: number;
  glass?: boolean;
  refraction?: number;
  dispersion?: number;
  glassSize?: number;
}

interface StrandRuntimeConfig {
  colors: string[];
  count: number;
  speed: number;
  amplitude: number;
  waviness: number;
  thickness: number;
  glow: number;
  taper: number;
  spread: number;
  hueShift: number;
  intensity: number;
  saturation: number;
  opacity: number;
  scale: number;
  glass: boolean;
  refraction: number;
  dispersion: number;
  glassSize: number;
  paused: boolean;
}

const VERT = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const FRAG = `#version 300 es
precision highp float;

uniform float uTime;
uniform vec2 uResolution;
uniform vec3 uColors[${MAX_COLORS}];
uniform int uColorCount;
uniform int uStrandCount;
uniform float uSpeed;
uniform float uAmplitude;
uniform float uWaviness;
uniform float uThickness;
uniform float uGlow;
uniform float uTaper;
uniform float uSpread;
uniform float uHueShift;
uniform float uIntensity;
uniform float uOpacity;
uniform float uScale;
uniform float uSaturation;

out vec4 fragColor;

const float PI = 3.14159265;

vec3 spectrum(float t) {
  return 0.5 + 0.5 * cos(2.0 * PI * (t + vec3(0.00, 0.33, 0.67)));
}

vec3 samplePalette(float t) {
  t = fract(t);
  float scaled = t * float(uColorCount);
  int idx = int(floor(scaled));
  float blend = fract(scaled);
  int nextIdx = idx + 1;
  if (nextIdx >= uColorCount) nextIdx = 0;
  return mix(uColors[idx], uColors[nextIdx], blend);
}

vec3 strandColor(float t) {
  if (uColorCount > 0) return samplePalette(t);
  return spectrum(t);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
  uv /= max(uScale, 0.0001);

  float e = 0.06 + uIntensity * 0.94;
  float env = pow(max(cos(uv.x * PI * 1.3), 0.0), uTaper);

  vec3 col = vec3(0.0);

  for (int i = 0; i < ${MAX_STRANDS}; i++) {
    if (i >= uStrandCount) break;

    float fi = float(i);
    float ph = fi * 1.7 * uSpread;
    float freq = (2.0 + fi * 0.35) * uWaviness;
    float spd = 1.4 + fi * 1.2;

    float tt = uTime * uSpeed;
    float w = sin(uv.x * freq + tt * spd + ph) * 0.60
            + sin(uv.x * freq * 1.1 - tt * spd * 0.7 + ph * 1.7) * 0.40;

    float amp = (0.1 + 0.02 * e) * env * uAmplitude;
    float y = w * amp;

    float d = abs(uv.y - y);
    float thick = (0.001 + 0.05 * e) * (0.35 + env) * uThickness;
    float g = thick / (d + thick * 0.45);
    g = g * g;

    float h = fi / float(uStrandCount) + uv.x * 0.30 + uTime * 0.04 + uHueShift;
    col += strandColor(h) * g * env;
  }

  col *= 0.45 + 0.7 * e;
  col = 1.0 - exp(-col * uGlow);

  float gray = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = max(mix(vec3(gray), col, uSaturation), 0.0);

  float lum = max(max(col.r, col.g), col.b);
  float alpha = clamp(lum, 0.0, 1.0) * uOpacity;

  fragColor = vec4(col * uOpacity, alpha);
}
`;

const GLASS_FRAG = `#version 300 es
precision highp float;

uniform sampler2D uScene;
uniform vec2 uResolution;
uniform float uRadius;
uniform float uRefraction;
uniform float uDispersion;

out vec4 fragColor;

vec2 toUv(vec2 p) {
  return p * (uResolution.y / uResolution) + 0.5;
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
  float d = length(p);
  float r = uRadius;

  float edge = fwidth(d) * 1.5;
  float mask = 1.0 - smoothstep(r - edge, r + edge, d);
  if (mask <= 0.0) {
    fragColor = vec4(0.0);
    return;
  }

  // sphere height: 0 at the rim, 1 at the center
  float z = sqrt(max(r * r - d * d, 0.0)) / r;
  float nd = d / r; // 0 at the center, 1 at the rim

  // refraction is confined to a narrow band near the rim; the rest stays undistorted
  vec2 dir = d > 0.0 ? p / d : vec2(0.0);
  float lens = smoothstep(0.85, 1.0, nd) * pow(nd, 6.0);
  vec2 offset = -dir * lens * uRefraction * 0.15;
  vec2 disp = -dir * lens * uDispersion * 0.012;

  vec3 light;
  light.r = texture(uScene, toUv(p + offset - disp)).r;
  light.g = texture(uScene, toUv(p + offset)).g;
  light.b = texture(uScene, toUv(p + offset + disp)).b;

  // neutral fresnel rim (no color tint so the glass stays clear)
  float fres = pow(1.0 - z, 3.0);
  vec3 rim = vec3(1.0) * fres * 0.18;

  // specular highlight from the upper-left
  vec2 lightDir = normalize(vec2(-0.55, 0.6));
  float spec = pow(max(dot(p / max(r, 1e-4), lightDir), 0.0), 6.0);
  spec *= smoothstep(r, r * 0.55, d);

  vec3 emissive = light + rim + vec3(spec) * 0.4;
  float emissiveA = clamp(max(max(emissive.r, emissive.g), emissive.b), 0.0, 1.0);

  // almost clear glass body: only a faint neutral darkening, mostly near the rim
  float bodyA = 0.05 + fres * 0.05;

  // composite emissive light over the clear body (premultiplied)
  float outA = emissiveA + bodyA * (1.0 - emissiveA);
  vec3 outRGB = emissive;

  outRGB *= mask;
  outA *= mask;

  fragColor = vec4(outRGB, outA);
}
`;

const buildPalette = (colors: string[]): Array<[number, number, number]> => {
  const filled = colors && colors.length ? colors : ['#ffffff'];
  const padded: Array<[number, number, number]> = [];
  for (let i = 0; i < MAX_COLORS; i++) {
    const hex = filled[i] ?? filled[filled.length - 1];
    const c = new Color(hex);
    padded.push([c.r, c.g, c.b]);
  }
  return padded;
};

export function Strands({
  className,
  style,
  dpr,
  paused = false,
  colors = ['#FF4242', '#7C3AED', '#06B6D4', '#EAB308'],
  count = 3,
  speed = 0.5,
  amplitude = 1,
  waviness = 1,
  thickness = 0.7,
  glow = 2.6,
  taper = 3,
  spread = 1,
  hueShift = 0,
  intensity = 0.6,
  saturation = 1.5,
  opacity = 1,
  scale = 1.5,
  glass = false,
  refraction = 1,
  dispersion = 1,
  glassSize = 1,
}: StrandsProps) {
  const propsRef = useRef<StrandRuntimeConfig>({} as StrandRuntimeConfig);
  propsRef.current = {
    colors,
    count,
    speed,
    amplitude,
    waviness,
    thickness,
    glow,
    taper,
    spread,
    hueShift,
    intensity,
    saturation,
    opacity,
    scale,
    glass,
    refraction,
    dispersion,
    glassSize,
    paused,
  };

  const ctnDom = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const ctn = ctnDom.current;
    if (!ctn) return;

    const reduced = prefersReducedMotion();
    const cleanups: Array<() => void> = [];
    const runCleanups = () => {
      while (cleanups.length) {
        try {
          cleanups.pop()?.();
        } catch {
          /* 静默忽略 */
        }
      }
    };

    let renderer: Renderer;
    try {
      renderer = new Renderer({
        dpr: clampDpr(dpr),
        alpha: true,
        premultipliedAlpha: true,
        antialias: true,
      });
    } catch {
      setFailed(true);
      return;
    }

    const gl = renderer.gl;
    const canvas = gl.canvas as HTMLCanvasElement;
    let program: Program | null = null;
    let renderTarget: RenderTarget | null = null;

    const releaseResources = () => {
      safeCallMethod(program, 'remove');
      safeCallMethod(renderTarget, 'remove');
      safeCallMethod(renderer, 'destroy');
      loseGlContext(gl);
      program = null;
      renderTarget = null;
    };

    cleanups.push(() => {
      if (canvas.parentElement === ctn) ctn.removeChild(canvas);
    });

    try {
      gl.clearColor(0, 0, 0, 0);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      canvas.style.backgroundColor = 'transparent';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.display = 'block';

      const initialWidth = Math.max(1, ctn.offsetWidth);
      const initialHeight = Math.max(1, ctn.offsetHeight);

      const geometry = new Triangle(gl);
      if ((geometry.attributes as Record<string, unknown>).uv) {
        delete (geometry.attributes as Record<string, unknown>).uv;
      }

      const current = propsRef.current;
      program = new Program(gl, {
        vertex: VERT,
        fragment: FRAG,
        uniforms: {
          uTime: { value: 0 },
          uResolution: { value: [initialWidth, initialHeight] },
          uColors: { value: buildPalette(current.colors) },
          uColorCount: { value: Math.min(current.colors.length, MAX_COLORS) },
          uStrandCount: { value: Math.min(Math.max(Math.round(current.count), 1), MAX_STRANDS) },
          uSpeed: { value: current.speed },
          uAmplitude: { value: current.amplitude },
          uWaviness: { value: current.waviness },
          uThickness: { value: current.thickness },
          uGlow: { value: current.glow },
          uTaper: { value: current.taper },
          uSpread: { value: current.spread },
          uHueShift: { value: current.hueShift },
          uIntensity: { value: current.intensity },
          uOpacity: { value: current.opacity },
          uScale: { value: current.scale },
          uSaturation: { value: current.saturation },
        },
      });

      const mesh = new Mesh(gl, { geometry, program });

      renderTarget = new RenderTarget(gl, {
        width: initialWidth,
        height: initialHeight,
      });

      const glassProgram = new Program(gl, {
        vertex: VERT,
        fragment: GLASS_FRAG,
        uniforms: {
          uScene: { value: renderTarget.texture },
          uResolution: { value: [initialWidth, initialHeight] },
          uRadius: { value: 0.46 * current.glassSize },
          uRefraction: { value: current.refraction },
          uDispersion: { value: current.dispersion },
        },
      });
      const glassMesh = new Mesh(gl, { geometry, program: glassProgram });

      ctn.appendChild(canvas);

      // 调色板缓存：仅在 colors 变化时重建，避免每帧解析 hex
      let paletteKey = '';
      let cachedPalette: Array<[number, number, number]> | null = null;
      const ensurePalette = (nextColors: string[]) => {
        const key = nextColors.join('|');
        if (!cachedPalette || key !== paletteKey) {
          cachedPalette = buildPalette(nextColors);
          paletteKey = key;
        }
        return cachedPalette;
      };

      const syncUniforms = () => {
        if (!program || !renderTarget) return;
        const cfg = propsRef.current;
        const uniforms = program.uniforms;
        uniforms.uColors.value = ensurePalette(cfg.colors);
        uniforms.uColorCount.value = Math.min(cfg.colors.length, MAX_COLORS);
        uniforms.uStrandCount.value = Math.min(Math.max(Math.round(cfg.count), 1), MAX_STRANDS);
        uniforms.uSpeed.value = cfg.speed;
        uniforms.uAmplitude.value = cfg.amplitude;
        uniforms.uWaviness.value = cfg.waviness;
        uniforms.uThickness.value = cfg.thickness;
        uniforms.uGlow.value = cfg.glow;
        uniforms.uTaper.value = cfg.taper;
        uniforms.uSpread.value = cfg.spread;
        uniforms.uHueShift.value = cfg.hueShift;
        uniforms.uIntensity.value = cfg.intensity;
        uniforms.uOpacity.value = cfg.opacity;
        uniforms.uScale.value = cfg.scale;
        uniforms.uSaturation.value = cfg.saturation;
      };

      const drawFrame = (time: number) => {
        if (!program || !renderTarget) return;
        const cfg = propsRef.current;
        syncUniforms();
        program.uniforms.uTime.value = time;

        try {
          if (cfg.glass) {
            renderer.render({ scene: mesh, target: renderTarget });
            glassProgram.uniforms.uScene.value = renderTarget.texture;
            glassProgram.uniforms.uRefraction.value = cfg.refraction;
            glassProgram.uniforms.uDispersion.value = cfg.dispersion;
            glassProgram.uniforms.uRadius.value = 0.46 * cfg.glassSize;
            renderer.render({ scene: glassMesh });
          } else {
            renderer.render({ scene: mesh });
          }
        } catch {
          /* 单帧渲染失败时静默 */
        }
      };

      const resize = () => {
        if (!program || !renderTarget) return;
        const width = Math.max(1, ctn.offsetWidth);
        const height = Math.max(1, ctn.offsetHeight);
        renderer.setSize(width, height);
        program.uniforms.uResolution.value = [width, height];
        renderTarget.setSize(width, height);
        glassProgram.uniforms.uResolution.value = [width, height];
      };

      let inView = true;
      if (typeof IntersectionObserver === 'function') {
        const io = new IntersectionObserver((entries) => {
          inView = entries.some((entry) => entry.isIntersecting);
        });
        io.observe(ctn);
        cleanups.push(() => io.disconnect());
      }

      const ro = new ResizeObserver(() => {
        resize();
        if (reduced) drawFrame(STATIC_FRAME_TIME);
      });
      ro.observe(ctn);
      cleanups.push(() => ro.disconnect());

      resize();

      if (reduced) {
        // prefers-reduced-motion：仅渲染一帧静态画面，不启动动画循环
        drawFrame(STATIC_FRAME_TIME);
        return () => {
          runCleanups();
          releaseResources();
        };
      }

      let rafId = 0;
      let lastSeconds = 0;
      let clock = 0;

      const loop = (tMs: number) => {
        rafId = requestAnimationFrame(loop);
        const t = tMs * 0.001;
        const dt = lastSeconds > 0 ? Math.min(t - lastSeconds, MAX_DELTA_SECONDS) : 0;
        lastSeconds = t;
        // 性能守卫：不可见 / 页面隐藏 / 手动暂停时跳过渲染
        if (propsRef.current.paused || document.hidden || !inView) return;
        clock += dt;
        drawFrame(clock);
      };
      rafId = requestAnimationFrame(loop);
      cleanups.push(() => cancelAnimationFrame(rafId));

      return () => {
        runCleanups();
        releaseResources();
      };
    } catch {
      runCleanups();
      releaseResources();
      setFailed(true);
      return;
    }
  }, [dpr]);

  if (failed) return null;

  return (
    <div
      ref={ctnDom}
      className={`strands-container ${className ?? ''}`}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        background: 'transparent',
        ...style,
      }}
    />
  );
}

export default Strands;
