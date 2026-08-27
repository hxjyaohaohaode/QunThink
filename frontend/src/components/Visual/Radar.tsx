import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Renderer, Program, Mesh, Triangle } from 'ogl';
import { clampDpr, hexToRgb, loseGlContext, prefersReducedMotion, safeCallMethod } from './webglShared';

const STATIC_FRAME_TIME = 0.35;
const MAX_DELTA_SECONDS = 0.05;

export interface RadarProps {
  className?: string;
  style?: CSSProperties;
  dpr?: number;
  paused?: boolean;
  speed?: number;
  scale?: number;
  ringCount?: number;
  spokeCount?: number;
  ringThickness?: number;
  spokeThickness?: number;
  sweepSpeed?: number;
  sweepWidth?: number;
  sweepLobes?: number;
  color?: string;
  backgroundColor?: string;
  falloff?: number;
  brightness?: number;
  enableMouseInteraction?: boolean;
  mouseInfluence?: number;
}

/**
 * 供洞察页（GroupInfoPage 等）后续接入的静态推荐配置：
 * 主题紫色调、关闭鼠标交互（信息展示场景）、稍密的环/辐条。
 * 用法：<Radar {...RADAR_INSIGHT_PRESET} className="..." />
 */
export const RADAR_INSIGHT_PRESET: RadarProps = {
  speed: 1.0,
  scale: 0.55,
  ringCount: 12,
  spokeCount: 12,
  ringThickness: 0.05,
  spokeThickness: 0.01,
  sweepSpeed: 1.2,
  sweepWidth: 2.2,
  sweepLobes: 1,
  color: '#6C5CE7',
  backgroundColor: '#0B0B14',
  falloff: 2.0,
  brightness: 1.0,
  enableMouseInteraction: false,
  mouseInfluence: 0.1,
};

const vertexShader = `
attribute vec2 uv;
attribute vec2 position;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 0, 1);
}
`;

const fragmentShader = `
precision highp float;

uniform float uTime;
uniform vec3 uResolution;
uniform float uSpeed;
uniform float uScale;
uniform float uRingCount;
uniform float uSpokeCount;
uniform float uRingThickness;
uniform float uSpokeThickness;
uniform float uSweepSpeed;
uniform float uSweepWidth;
uniform float uSweepLobes;
uniform vec3 uColor;
uniform vec3 uBgColor;
uniform float uFalloff;
uniform float uBrightness;
uniform vec2 uMouse;
uniform float uMouseInfluence;
uniform bool uEnableMouse;

#define TAU 6.28318530718
#define PI 3.14159265359

void main() {
  vec2 st = gl_FragCoord.xy / uResolution.xy;
  st = st * 2.0 - 1.0;
  st.x *= uResolution.x / uResolution.y;

  if (uEnableMouse) {
    vec2 mShift = (uMouse * 2.0 - 1.0);
    mShift.x *= uResolution.x / uResolution.y;
    st -= mShift * uMouseInfluence;
  }

  st *= uScale;

  float dist = length(st);
  float theta = atan(st.y, st.x);
  float t = uTime * uSpeed;

  float ringPhase = dist * uRingCount - t;
  float ringDist = abs(fract(ringPhase) - 0.5);
  float ringGlow = 1.0 - smoothstep(0.0, uRingThickness, ringDist);

  float spokeAngle = abs(fract(theta * uSpokeCount / TAU + 0.5) - 0.5) * TAU / uSpokeCount;
  float arcDist = spokeAngle * dist;
  float spokeGlow = (1.0 - smoothstep(0.0, uSpokeThickness, arcDist)) * smoothstep(0.0, 0.1, dist);

  float sweepPhase = t * uSweepSpeed;
  float sweepBeam = pow(max(0.5 * sin(uSweepLobes * theta + sweepPhase) + 0.5, 0.0), uSweepWidth);

  float fade = smoothstep(1.05, 0.85, dist) * pow(max(1.0 - dist, 0.0), uFalloff);

  float intensity = max((ringGlow + spokeGlow + sweepBeam) * fade * uBrightness, 0.0);
  vec3 col = uColor * intensity + uBgColor;

  float alpha = clamp(length(col), 0.0, 1.0);
  gl_FragColor = vec4(col, alpha);
}
`;

export function Radar({
  className,
  style,
  dpr,
  paused = false,
  speed = 1.0,
  scale = 0.5,
  ringCount = 10.0,
  spokeCount = 10.0,
  ringThickness = 0.05,
  spokeThickness = 0.01,
  sweepSpeed = 1.0,
  sweepWidth = 2.0,
  sweepLobes = 1.0,
  color = '#9f29ff',
  backgroundColor = '#000000',
  falloff = 2.0,
  brightness = 1.0,
  enableMouseInteraction = true,
  mouseInfluence = 0.1,
}: RadarProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

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
      renderer = new Renderer({ dpr: clampDpr(dpr), alpha: true, premultipliedAlpha: false });
    } catch {
      setFailed(true);
      return;
    }

    const gl = renderer.gl;
    const canvas = gl.canvas as HTMLCanvasElement;
    let program: Program | null = null;

    const releaseResources = () => {
      safeCallMethod(program, 'remove');
      safeCallMethod(renderer, 'destroy');
      loseGlContext(gl);
      program = null;
    };

    cleanups.push(() => {
      if (canvas.parentElement === container) container.removeChild(canvas);
    });

    try {
      gl.clearColor(0, 0, 0, 0);
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.display = 'block';
      container.appendChild(canvas);

      program = new Program(gl, {
        vertex: vertexShader,
        fragment: fragmentShader,
        uniforms: {
          uTime: { value: 0 },
          uResolution: {
            value: [gl.drawingBufferWidth, gl.drawingBufferHeight, gl.drawingBufferWidth / Math.max(1, gl.drawingBufferHeight)],
          },
          uSpeed: { value: speed },
          uScale: { value: scale },
          uRingCount: { value: ringCount },
          uSpokeCount: { value: spokeCount },
          uRingThickness: { value: ringThickness },
          uSpokeThickness: { value: spokeThickness },
          uSweepSpeed: { value: sweepSpeed },
          uSweepWidth: { value: sweepWidth },
          uSweepLobes: { value: sweepLobes },
          uColor: { value: hexToRgb(color) },
          uBgColor: { value: hexToRgb(backgroundColor) },
          uFalloff: { value: falloff },
          uBrightness: { value: brightness },
          uMouse: { value: [0.5, 0.5] },
          uMouseInfluence: { value: mouseInfluence },
          uEnableMouse: { value: enableMouseInteraction && !reduced },
        },
      });

      const geometry = new Triangle(gl);
      const mesh = new Mesh(gl, { geometry, program });

      const resize = () => {
        const rect = container.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        renderer.setSize(Math.floor(rect.width), Math.floor(rect.height));
        if (program) {
          program.uniforms.uResolution.value = [
            gl.drawingBufferWidth,
            gl.drawingBufferHeight,
            gl.drawingBufferWidth / Math.max(1, gl.drawingBufferHeight),
          ];
        }
      };

      let inView = true;
      if (typeof IntersectionObserver === 'function') {
        const io = new IntersectionObserver((entries) => {
          inView = entries.some((entry) => entry.isIntersecting);
        });
        io.observe(container);
        cleanups.push(() => io.disconnect());
      }

      const ro = new ResizeObserver(() => {
        resize();
        if (reduced) drawFrame(STATIC_FRAME_TIME);
      });
      ro.observe(container);
      cleanups.push(() => ro.disconnect());

      resize();

      let targetMouse: [number, number] = [0.5, 0.5];
      const handleMouseMove = (e: MouseEvent) => {
        const rect = canvas.getBoundingClientRect();
        targetMouse = [
          (e.clientX - rect.left) / Math.max(1, rect.width),
          1.0 - (e.clientY - rect.top) / Math.max(1, rect.height),
        ];
      };
      const handleMouseLeave = () => {
        targetMouse = [0.5, 0.5];
      };
      if (enableMouseInteraction && !reduced) {
        canvas.addEventListener('mousemove', handleMouseMove);
        canvas.addEventListener('mouseleave', handleMouseLeave);
        cleanups.push(() => {
          canvas.removeEventListener('mousemove', handleMouseMove);
          canvas.removeEventListener('mouseleave', handleMouseLeave);
        });
      }

      const drawFrame = (time: number) => {
        if (!program) return;
        program.uniforms.uTime.value = time;
        try {
          renderer.render({ scene: mesh });
        } catch {
          /* 单帧渲染失败时静默 */
        }
      };

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
        if (paused || document.hidden || !inView) return;
        clock += dt;
        if (program) {
          if (enableMouseInteraction) {
            const mouseUniform = program.uniforms.uMouse.value as number[];
            mouseUniform[0] += 0.05 * (targetMouse[0] - mouseUniform[0]);
            mouseUniform[1] += 0.05 * (targetMouse[1] - mouseUniform[1]);
          } else {
            const mouseUniform = program.uniforms.uMouse.value as number[];
            mouseUniform[0] = 0.5;
            mouseUniform[1] = 0.5;
          }
        }
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
  }, [
    dpr,
    paused,
    speed,
    scale,
    ringCount,
    spokeCount,
    ringThickness,
    spokeThickness,
    sweepSpeed,
    sweepWidth,
    sweepLobes,
    color,
    backgroundColor,
    falloff,
    brightness,
    enableMouseInteraction,
    mouseInfluence,
  ]);

  if (failed) return null;

  return (
    <div
      ref={containerRef}
      className={`radar-container ${className ?? ''}`}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        ...style,
      }}
    />
  );
}

export default Radar;
