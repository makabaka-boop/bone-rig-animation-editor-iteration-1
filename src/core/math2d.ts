import type { Vec2 } from './types';

export const TAU = Math.PI * 2;

export function vec(x: number, y: number): Vec2 {
  return { x, y };
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(a: Vec2, s: number): Vec2 {
  return { x: a.x * s, y: a.y * s };
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function length(a: Vec2): number {
  return Math.hypot(a.x, a.y);
}

export function fromAngle(angle: number, len: number): Vec2 {
  return { x: Math.cos(angle) * len, y: Math.sin(angle) * len };
}

/** 将任意角度归一化到 [-PI, PI) */
export function normalizeAngle(a: number): number {
  let r = a % TAU;
  if (r >= Math.PI) r -= TAU;
  if (r < -Math.PI) r += TAU;
  return r;
}

/** 将 a 夹到 [min, max]；区间非法（min > max）时退化为 min */
export function clampAngle(a: number, min: number, max: number): number {
  if (!(max >= min)) return min;
  return Math.min(max, Math.max(min, a));
}

/**
 * 角度插值，走最短弧。关键帧角度为局部量，
 * 相邻两帧可能在 ±PI 两侧，直接线性插值会绕远路。
 */
export function lerpAngle(a: number, b: number, t: number): number {
  return a + normalizeAngle(b - a) * t;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function approx(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps;
}

export function approxVec(a: Vec2, b: Vec2, eps = 1e-9): boolean {
  return dist(a, b) <= eps;
}
