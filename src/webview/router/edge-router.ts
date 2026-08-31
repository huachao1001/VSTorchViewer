// EdgeRouter：连线路由算法（独立模块）
//
// 职责边界：布局层（GraphModel）用两遍 dagre 完成布局（背景盒空间已烘焙进布局，布局后零位移），
// 并产出 dagre 的原生路由点；本模块把这些路由点加工成可绘制的链；
// 渲染层（EdgeRenderer）只把锚点序列变成 SVG path。三层互不渗透。
//
// 为什么用 dagre 的路由点：dagre 的分层布局保证
//   - 边只走排间空隙与虚拟节点通道，不穿过任何真实节点（虚拟节点与真实节点保持 nodesep 间距）
//   - 相邻边之间保持 edgesep 间隔，不重叠
//   - 交叉最小化（中位数/重心排序）
// 本模块只做三件事：统一方向（dagre 对回边可能反序存储）、端点从"膨胀矩形"收回到真实节点边缘、
// 平行边横向错开。
import type { Chain, GEdge, GNode, Pt } from '../types';

export class EdgeRouter {
  // points: dagre 输出的路由点（key = "src>dst"，首末点位于膨胀矩形边界）
  static fromDagre(
    points: Map<string, Pt[]>,
    edges: GEdge[],
    idx: Map<number, GNode>,
    rankOf: Map<number, number>
  ): Chain[] {
    // 同一对节点间的平行边横向错开（不合并成一条箭头）
    const groups = new Map<string, GEdge[]>();
    for (const e of edges) {
      const k = Math.min(e.src, e.dst) + '|' + Math.max(e.src, e.dst);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(e);
    }
    const offsetOf = new Map<GEdge, number>();
    for (const es of groups.values()) {
      const n = es.length;
      es.forEach((e, j) => offsetOf.set(e, (j - (n - 1) / 2) * 9));
    }

    const chains: Chain[] = [];
    for (const e of edges) {
      const s = idx.get(e.src);
      const t = idx.get(e.dst);
      const raw = points.get(e.src + '>' + e.dst);
      if (!s || !t || !raw || raw.length < 2) continue;
      const pts = raw.map(p => ({ ...p }));

      // dagre 对回边可能按反转方向存储：统一为 src → dst
      const sc = { x: s.x! + s.w! / 2, y: s.y! + s.h! / 2 };
      const tc = { x: t.x! + t.w! / 2, y: t.y! + t.h! / 2 };
      if (d2(pts[0], tc) < d2(pts[0], sc)) pts.reverse();

      // 端点重锚：dagre 首末点在"膨胀矩形"边界上，沿视觉方向收回到真实节点边缘
      pts[0] = exitPoint(sc, pts[1], s);
      pts[pts.length - 1] = exitPoint(tc, pts[pts.length - 2], t);

      // 平行边整体横向错开（端点仍落在节点边缘上）
      const o = offsetOf.get(e) ?? 0;
      if (o) for (const p of pts) p.x += o;

      const dashed = (rankOf.get(s.id) ?? 0) > (rankOf.get(t.id) ?? 0);
      chains.push({ src: e.src, dst: e.dst, path: pts, dashed });
    }
    return chains;
  }
}

function d2(a: Pt, b: Pt): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

// 从 node 中心射向 outer 的射线与节点真实矩形的交点（离开矩形的位置）
function exitPoint(center: Pt, outer: Pt, n: GNode): Pt {
  const dx = outer.x - center.x;
  const dy = outer.y - center.y;
  const x1 = n.x!, x2 = n.x! + n.w!, y1 = n.y!, y2 = n.y! + n.h!;
  let t = Infinity;
  if (dx > 0) t = Math.min(t, (x2 - center.x) / dx);
  else if (dx < 0) t = Math.min(t, (x1 - center.x) / dx);
  if (dy > 0) t = Math.min(t, (y2 - center.y) / dy);
  else if (dy < 0) t = Math.min(t, (y1 - center.y) / dy);
  if (!isFinite(t)) return { x: center.x, y: center.y };
  return { x: center.x + t * dx, y: center.y + t * dy };
}
