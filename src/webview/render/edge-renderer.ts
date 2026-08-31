// EdgeRenderer：连线路径（dagre 路由点折线 + 圆角拐角 / 簇间 S 形贝塞尔）
import type { Chain, GNode, Pt } from '../types';
import { el, pt } from '../utils';

export class EdgeRenderer {
  build(c: Chain, idx: Map<number, GNode>): SVGElement {
    const pts = c.path;
    let d: string;
    if (pts.length === 2) {
      const [a, b] = pts;
      if (Math.abs(a.x - b.x) < 0.5 || Math.abs(a.y - b.y) < 0.5) {
        // 路由器给出的水平/垂直直连
        d = `M ${pt(a)} L ${pt(b)}`;
      } else {
        // S 形贝塞尔
        if (Math.abs(b.y - a.y) >= Math.abs(b.x - a.x)) {
          const my = (a.y + b.y) / 2;
          d = `M ${pt(a)} C ${a.x.toFixed(1)} ${my.toFixed(1)}, ${b.x.toFixed(1)} ${my.toFixed(1)}, ${pt(b)}`;
        } else {
          const mx = (a.x + b.x) / 2;
          d = `M ${pt(a)} C ${mx.toFixed(1)} ${a.y.toFixed(1)}, ${mx.toFixed(1)} ${b.y.toFixed(1)}, ${pt(b)}`;
        }
      }
    } else if (pts.length > 2) {
      // dagre 路由点 → 折线，拐角用小圆角过渡
      const R = 8;
      d = `M ${pt(pts[0])}`;
      for (let i = 1; i + 1 < pts.length; i++) {
        const p = pts[i];
        const prev = pts[i - 1];
        const next = pts[i + 1];
        const dIn = Math.hypot(p.x - prev.x, p.y - prev.y) || 1;
        const dOut = Math.hypot(next.x - p.x, next.y - p.y) || 1;
        const r = Math.min(R, dIn / 2, dOut / 2);
        const a = { x: p.x - ((p.x - prev.x) / dIn) * r, y: p.y - ((p.y - prev.y) / dIn) * r };
        const b = { x: p.x + ((next.x - p.x) / dOut) * r, y: p.y + ((next.y - p.y) / dOut) * r };
        d += ` L ${pt(a)} Q ${pt(p)} ${pt(b)}`;
      }
      d += ` L ${pt(pts[pts.length - 1])}`;
    } else {
      // 兜底：节点中心直连
      const s = idx.get(c.src)!;
      const t = idx.get(c.dst)!;
      d = `M ${pt({ x: s.x! + s.w!, y: s.y! + s.h! / 2 })} L ${pt({ x: t.x!, y: t.y! + t.h! / 2 })}`;
    }
    const path = el('path', { d, fill: 'none', class: 'edge' + (c.dashed ? ' back' : '') });
    path.dataset.src = String(c.src);
    path.dataset.dst = String(c.dst);
    return path;
  }
}

export type { Pt };
