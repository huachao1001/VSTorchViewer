// SVG 与格式化基础工具
import type { Pt } from './types';

export const NS = 'http://www.w3.org/2000/svg';

export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export function el(tag: string, attrs: Record<string, string | number>): SVGElement {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  return e;
}

export const pt = (p: Pt) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`;

let measureCtx: CanvasRenderingContext2D | null = null;
export function textW(s: string, font: string): number {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx) return s.length * 7;
  measureCtx.font = font;
  return measureCtx.measureText(s).width;
}

export function truncate(s: string, font: string, maxW: number): string {
  if (textW(s, font) <= maxW) return s;
  let t = s;
  while (t.length > 1 && textW(t + '…', font) > maxW) t = t.slice(0, -1);
  return t + '…';
}

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function fmtShape(s?: number[]): string {
  return s && s.length ? '[' + s.join(', ') + ']' : '';
}

export function fmtNum(n: number): string {
  if (!isFinite(n)) return String(n);
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

// 字体常量（卡片 / 面板排版统一从这里取）
export const FONT_NAME = '600 12px Consolas, "Courier New", monospace';
export const FONT_TYPE = '11px Consolas, "Courier New", monospace';
export const FONT_SHAPE = '10.5px Consolas, "Courier New", monospace';
export const FONT_SUMMARY = '10.5px Consolas, "Courier New", monospace';
export const FONT_PANEL = '600 12px "Segoe UI", system-ui, sans-serif';
export const FONT_PANEL_SUB = '10.5px Consolas, "Courier New", monospace';
