// GraphModel：数据模型核心
// 职责：层级计算（语义缩放）、模块折叠、dagre 布局、背景盒空间后处理、组合背景几何、选中解析
// 不接触 DOM；渲染层只读取它暴露的 nodes/idx/chains/panels
import dagre from '@dagrejs/dagre';
import type { Chain, GEdge, GNode, GraphData, Panel, Pt, ResolvedSelection, Selection } from './types';
import { sizeNode } from './node-metrics';
import { EdgeRouter } from './router/edge-router';

// 缩放下限：保证卡片文字可读（12px→9.6px、10.5px→8.4px），禁止缩得更小
export const K_MIN = 0.8;

const PANEL_PAD = 14;
const PANEL_HEADER = 34;

export function entityKey(nd: GNode): string {
  return nd.clusterKey ? 'c:' + nd.clusterKey : 'n:' + nd.id;
}

export class GraphModel {
  data: GraphData | null = null;
  levels: number[] = [Infinity]; // 可展开层级（group 路径深度，Infinity=完整算子级）
  level = 0; // 当前层级索引
  nodes: GNode[] = [];
  idx = new Map<number, GNode>();
  chains: Chain[] = [];
  panels: Panel[] = [];
  fullNodes: GNode[] = [];
  fullIdx = new Map<number, GNode>();
  fullChains: Chain[] = [];
  // 纯传递前缀（只含 1 个子组合、自身无算子）→ 不显示背景盒；折叠时下钻到唯一孩子
  private omit = new Set<string>();
  private omitChild = new Map<string, string>();
  // 当前各排的排号（finalizeLayout 位移后仍成立），供连线路由判定回边
  private rankOf = new Map<number, number>();
  // 全细节 dagre 布局的中心（一次性缓存）：所有层级对齐到它，保证跨层级内容稳定、缩放往返可逆
  private fullRef: Pt | null = null;

  // ---------- 装载 ----------

  load(data: GraphData, k: number): void {
    this.data = data;
    this.computeOmit();
    this.levels = this.computeLevels();
    this.layoutFull();
    this.level = this.zoomToLevel(k);
    this.buildLevelView(this.levels[this.level]);
  }

  // 组合省略规则：某组合只包含 1 个子组合且自身不直接挂算子 → 省略该组合（如 stem.primary 只含 stem.primary.fused）
  // 只包含 1 个真实算子的组合 → 保留显示
  private computeOmit(): void {
    const children = new Map<string, Set<string>>();
    const direct = new Set<string>();
    for (const nd of this.data!.nodes) {
      if (!nd.group) continue;
      direct.add(nd.group);
      const segs = nd.group.split('.');
      for (let i = 1; i < segs.length; i++) {
        const p = segs.slice(0, i).join('.');
        if (!children.has(p)) children.set(p, new Set());
        children.get(p)!.add(segs.slice(0, i + 1).join('.'));
      }
    }
    this.omit = new Set();
    this.omitChild = new Map();
    for (const [k, cs] of children) {
      if (cs.size === 1 && !direct.has(k)) {
        this.omit.add(k);
        this.omitChild.set(k, [...cs][0]);
      }
    }
  }

  // 被省略的前缀下钻到最深非省略前缀（折叠视图的簇卡片用它命名）
  private descendOmit(key: string): string {
    let k = key;
    while (this.omit.has(k)) k = this.omitChild.get(k)!;
    return k;
  }

  private computeLevels(): number[] {
    const depths = new Set<number>();
    for (const nd of this.data!.nodes) if (nd.group) depths.add(nd.group.split('.').length);
    const ds = [...depths].sort((a, b) => a - b);
    return ds.length ? [...ds, Infinity] : [Infinity];
  }

  // 缩放级别 → 折叠深度：阈值均匀分布在 [K_MIN, 1.5]，最粗层级在缩放下限处可达
  zoomToLevel(k: number): number {
    let idx = 0;
    const step = (1.5 - K_MIN) / Math.max(1, this.levels.length - 1);
    for (let i = 1; i < this.levels.length; i++) if (k >= K_MIN + i * step) idx = i;
    return idx;
  }

  // ---------- 层级视图（模块折叠） ----------

  setLevel(idx: number): void {
    this.level = idx;
    this.buildLevelView(this.levels[idx]);
  }

  // 构建某一级别的可见视图；布局只算一次（全细节），折叠级用紧凑 dagre 重排
  private buildLevelView(depth: number): void {
    const src = this.data!;
    if (depth === Infinity) {
      // 全细节：布局与连线在 layoutFull 一次性完成（零位移，路由点原生有效）
      this.nodes = this.fullNodes;
      this.idx = this.fullIdx;
      this.chains = this.fullChains;
      this.computePanels(Math.max(0, ...src.nodes.filter(n => n.group).map(n => n.group!.split('.').length)));
      return;
    }

    interface Cluster {
      key: string;
      members: number[];
      clsCount: Map<string, number>;
      params: number;
      shape?: number[];
    }
    const clusters = new Map<string, Cluster>();
    const nodeCluster = new Map<number, string>();
    const loose: GNode[] = [];
    for (const nd of src.nodes) {
      if (nd.kind === 'placeholder' || nd.kind === 'output' || !nd.group) {
        loose.push(nd);
        continue;
      }
      const key = this.descendOmit(nd.group.split('.').slice(0, depth).join('.'));
      let c = clusters.get(key);
      if (!c) {
        c = { key, members: [], clsCount: new Map(), params: 0 };
        clusters.set(key, c);
      }
      c.members.push(nd.id);
      nodeCluster.set(nd.id, key);
      if (nd.group_cls) c.clsCount.set(nd.group_cls, (c.clsCount.get(nd.group_cls) || 0) + 1);
      if (nd.params) c.params += nd.params;
      if (nd.out_shape && nd.out_shape.length) c.shape = nd.out_shape;
    }

    // 未分组算子：标签传播，归入邻接最多的模块簇（输入/输出节点保持独立）
    const adj = new Map<number, number[]>();
    for (const e of src.edges) {
      if (!adj.has(e.src)) adj.set(e.src, []);
      if (!adj.has(e.dst)) adj.set(e.dst, []);
      adj.get(e.src)!.push(e.dst);
      adj.get(e.dst)!.push(e.src);
    }
    const assign = new Map<number, string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const nd of loose) {
        if (nd.kind === 'placeholder' || nd.kind === 'output' || assign.has(nd.id)) continue;
        const counts = new Map<string, number>();
        let best: string | null = null;
        let bestN = 0;
        for (const nb of adj.get(nd.id) || []) {
          const c = nodeCluster.get(nb) ?? assign.get(nb);
          if (!c) continue;
          const n = (counts.get(c) || 0) + 1;
          counts.set(c, n);
          if (n > bestN) {
            bestN = n;
            best = c;
          }
        }
        if (best) {
          assign.set(nd.id, best);
          changed = true;
        }
      }
    }
    for (const [id, key] of assign) {
      const c = clusters.get(key)!;
      const nd = this.fullIdx.get(id)!;
      c.members.push(id);
      nodeCluster.set(id, key);
      if (nd.params) c.params += nd.params;
      if (nd.out_shape && nd.out_shape.length) c.shape = nd.out_shape;
    }

    // 簇卡片：与普通节点同样式；标题用模块路径
    const nodes: GNode[] = [];
    const cid = new Map<number, number>();
    let nextId = 100000;
    for (const c of clusters.values()) {
      const id = nextId++;
      const cls = [...c.clsCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'Module';
      const card: GNode = {
        id,
        name: c.key,
        kind: 'module-cluster',
        cls,
        params: c.params,
        group: c.key,
        group_cls: cls,
        summary: `${c.members.length} 个算子`,
        out_shape: c.shape,
        clusterKey: c.key,
      };
      sizeNode(card);
      nodes.push(card);
      for (const m of c.members) cid.set(m, id);
    }
    // 松散/IO 节点：用副本参与紧凑布局，避免污染全细节布局的坐标
    for (const nd of loose) {
      nodes.push({ ...this.fullIdx.get(nd.id)! });
    }
    this.nodes = nodes;
    this.idx = new Map(nodes.map(n => [n.id, n]));

    // 聚合边（去掉内部边；平行边保留，稍后错开绘制，不合并成一条箭头）
    const aggEdges: GEdge[] = [];
    for (const e of src.edges) {
      const s = cid.get(e.src) ?? e.src;
      const d = cid.get(e.dst) ?? e.dst;
      if (s === d) continue;
      aggEdges.push({ src: s, dst: d });
    }

    // 紧凑 dagre 重排 + 背景盒填充烘焙（两遍布局，布局后零位移，路由点原生有效）
    const { points, rankOf } = dagreWithPadding(this.nodes, aggEdges, { nodesep: 20, edgesep: 8, ranksep: 34 }, depth - 1, this.omit);
    this.rankOf = rankOf;
    const chains = EdgeRouter.fromDagre(points, aggEdges, this.idx, rankOf);

    // 与全细节布局对齐（固定参考中心，层级间内容稳定，缩放往返可逆）；连线随节点同步平移
    const delta = this.alignToRef();
    if (delta) {
      for (const c of chains) for (const p of c.path) {
        p.x += delta.x;
        p.y += delta.y;
      }
    }
    this.chains = chains;
    this.computePanels(depth - 1); // 折叠级：按父模块给拆开的成员套组合背景
  }

  // ---------- 全细节布局（只算一次） ----------

  private layoutFull(): void {
    const data = this.data!;
    this.nodes = data.nodes.map(n => ({ ...n }));
    this.idx = new Map(this.nodes.map(n => [n.id, n]));
    this.nodes.forEach(nd => sizeNode(nd));

    const maxLayer = Math.max(0, ...data.nodes.filter(n => n.group).map(n => n.group!.split('.').length));
    const { points, rankOf } = dagreWithPadding(this.nodes, data.edges, { nodesep: 24, edgesep: 8, ranksep: 44 }, maxLayer, this.omit);
    this.rankOf = rankOf;
    this.fullNodes = this.nodes;
    this.fullIdx = this.idx;
    this.fullChains = EdgeRouter.fromDagre(points, data.edges, this.idx, rankOf);

    // 缓存全细节布局中心（永不改变，其他层级对齐到它）
    let fx1 = Infinity,
      fx2 = -Infinity,
      fy1 = Infinity,
      fy2 = -Infinity;
    for (const nd of this.nodes) {
      fx1 = Math.min(fx1, nd.x!);
      fx2 = Math.max(fx2, nd.x! + nd.w!);
      fy1 = Math.min(fy1, nd.y!);
      fy2 = Math.max(fy2, nd.y! + nd.h!);
    }
    this.fullRef = isFinite(fx1) ? { x: (fx1 + fx2) / 2, y: (fy1 + fy2) / 2 } : null;
  }

  // 把当前节点整体平移，使包围盒中心对齐 fullRef（跨层级内容稳定）；返回平移量
  private alignToRef(): Pt | null {
    if (!this.fullRef) return null;
    let x1 = Infinity,
      x2 = -Infinity,
      y1 = Infinity,
      y2 = -Infinity;
    for (const nd of this.nodes) {
      x1 = Math.min(x1, nd.x!);
      x2 = Math.max(x2, nd.x! + nd.w!);
      y1 = Math.min(y1, nd.y!);
      y2 = Math.max(y2, nd.y! + nd.h!);
    }
    if (!isFinite(x1)) return null;
    const dx = this.fullRef.x - (x1 + x2) / 2;
    const dy = this.fullRef.y - (y1 + y2) / 2;
    if (dx === 0 && dy === 0) return null;
    this.nodes.forEach(nd => {
      nd.x! += dx;
      nd.y! += dy;
    });
    return { x: dx, y: dy };
  }

  // ---------- 组合背景几何：按模块层级嵌套（外层盒包住内层盒，标题条带逐层错开） ----------

  private computePanels(maxLayer: number): void {
    this.panels = [];
    if (maxLayer <= 0) return;
    const byKey = new Map<string, Panel>();
    for (const nd of this.nodes) {
      if (!nd.group || nd.kind === 'placeholder' || nd.kind === 'output') continue;
      const segs = nd.group.split('.').length;
      for (let layer = 1; layer <= Math.min(maxLayer, segs); layer++) {
        const key = nd.group.split('.').slice(0, layer).join('.');
        if (this.omit.has(key)) continue;
        if (nd.kind === 'module-cluster' && key === nd.group) continue; // 卡片自身不套盒
        let p = byKey.get(key);
        if (!p) {
          p = { key, label: key, clss: [], params: 0, xMin: nd.x!, xMax: nd.x! + nd.w!, yMin: nd.y!, yMax: nd.y! + nd.h!, nodes: [] };
          byKey.set(key, p);
        }
        p.nodes.push(nd);
        p.xMin = Math.min(p.xMin, nd.x!);
        p.xMax = Math.max(p.xMax, nd.x! + nd.w!);
        p.yMin = Math.min(p.yMin, nd.y!);
        p.yMax = Math.max(p.yMax, nd.y! + nd.h!);
        if (nd.group_cls && !p.clss.includes(nd.group_cls)) p.clss.push(nd.group_cls);
        if (nd.params) p.params += nd.params;
      }
    }
    for (const p of byKey.values()) {
      // 盒内只有 1 张簇卡片 = 纯嵌套，不显示；含真实算子（哪怕 1 个）则显示
      if (p.nodes.length === 1 && p.nodes[0].kind === 'module-cluster') continue;
      this.panels.push(p);
    }
    // 几何：按嵌套深度向外扩展，保证每层盒严格内含于外层盒，且各层标题条带互不重叠
    const maxL = Math.max(...this.panels.map(p => p.key.split('.').length - 1), 0);
    for (const p of this.panels) {
      const L = p.key.split('.').length - 1;
      const inward = maxL - L;
      p.x = p.xMin - PANEL_PAD - inward * 6;
      p.w = p.xMax - p.xMin + (PANEL_PAD + inward * 6) * 2;
      p.yTop = p.yMin - PANEL_PAD - (inward + 1) * PANEL_HEADER;
      p.yH = p.yMax + PANEL_PAD + inward * 6 - p.yTop;
    }
    // 外层（面积大）先画，内层叠在上面
    this.panels.sort((a, b) => (b.xMax - b.xMin) * (b.yMax - b.yMin) - (a.xMax - a.xMin) * (a.yMax - a.yMin));
  }

  // ---------- 选中解析：跨层级传播（模块 ↔ 成员算子） ----------

  resolveSelection(sel: Selection | null): ResolvedSelection {
    const ids = new Set<number>();
    let primary: GNode | null = null;
    if (sel) {
      const D = this.levels[this.level];
      if (!sel.group) {
        const n = this.nodes.find(m => m.id === sel.id);
        if (n) {
          ids.add(n.id);
          primary = n;
        }
      } else if (D === Infinity) {
        if (sel.isCluster) {
          const G = sel.group;
          for (const n of this.nodes) {
            if (n.group && (n.group === G || n.group.startsWith(G + '.'))) {
              ids.add(n.id);
              if (!primary) primary = n;
            }
          }
        } else {
          const n = this.idx.get(sel.id);
          if (n) {
            ids.add(n.id);
            primary = n;
          }
        }
      } else {
        const want = sel.isCluster ? sel.group : sel.group.split('.').slice(0, D).join('.');
        for (const n of this.nodes) {
          if (!n.clusterKey) continue;
          if (n.clusterKey === want || n.clusterKey.startsWith(want + '.') || want.startsWith(n.clusterKey + '.')) {
            ids.add(n.id);
            if (!primary) primary = n;
          }
        }
        if (!primary) {
          const n = this.nodes.find(m => m.clusterKey === sel.group);
          if (n) {
            ids.add(n.id);
            primary = n;
          }
        }
      }
    }
    return { ids, primary };
  }

  // ---------- 树回退视图的布局（符号追踪失败时） ----------

  prepareTreeFallback(): GNode | null {
    const root = this.data?.root;
    if (!root) return null;
    const W = 210;
    const HG = 70;
    const VG = 16;
    const H = 44;
    const subtree = (nd: GNode): number => {
      nd.w = W;
      nd.h = H;
      const kids = nd.children || [];
      if (!kids.length) return (nd.sh = H);
      let t = 0;
      kids.forEach((k, i) => {
        t += subtree(k) + (i ? VG : 0);
      });
      return (nd.sh = Math.max(H, t));
    };
    const place = (nd: GNode, top: number, depth: number): void => {
      nd.x = depth * (W + HG);
      nd.y = top + (nd.sh! - H) / 2;
      let ct = top;
      (nd.children || []).forEach(k => {
        place(k, ct, depth + 1);
        ct += k.sh! + VG;
      });
    };
    subtree(root);
    place(root, 0, 0);
    this.nodes = [];
    this.idx = new Map();
    this.chains = [];
    this.panels = [];
    const walk = (nd: GNode): void => {
      this.nodes.push(nd);
      this.idx.set(nd.id, nd);
      (nd.children || []).forEach(k => walk(k));
    };
    walk(root);
    return root;
  }
}

// ================= 布局辅助（模块级纯函数） =================

interface DagreOpts {
  nodesep: number;
  edgesep: number;
  ranksep: number;
}

// 单遍 dagre 布局。inflV/inflH 为每节点的膨胀量（只参与布局计算，不改动真实尺寸），
// 用于把背景盒所需空间直接烘焙进布局，使布局后无需任何位移。
function runDagre(
  nodes: GNode[],
  edges: GEdge[],
  opts: DagreOpts,
  inflV: Map<number, number>,
  inflH: Map<number, number>
): { pos: Map<number, Pt>; points: Map<string, Pt[]> } {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', marginx: 0, marginy: 0, ...opts });
  g.setDefaultNodeLabel(() => ({}));
  g.setDefaultEdgeLabel(() => ({}));
  nodes.forEach(nd => {
    g.setNode(String(nd.id), { width: nd.w! + (inflH.get(nd.id) ?? 0), height: nd.h! + (inflV.get(nd.id) ?? 0) });
  });
  edges.forEach(e => g.setEdge(String(e.src), String(e.dst)));
  dagre.layout(g);
  const pos = new Map<number, Pt>();
  nodes.forEach(nd => {
    const p = g.node(String(nd.id));
    pos.set(nd.id, { x: p.x, y: p.y });
  });
  const points = new Map<string, Pt[]>();
  edges.forEach(e => {
    const ge = g.edge(String(e.src), String(e.dst)) as { points?: Pt[] } | undefined;
    if (ge?.points) points.set(e.src + '>' + e.dst, ge.points.map(p => ({ x: p.x, y: p.y })));
  });
  return { pos, points };
}

// 排（rank）：dagre 同排节点的中心 y 相同
function computeRanks(nodes: GNode[]): { rankOf: Map<number, number>; ranks: GNode[][] } {
  const ys = [...new Set(nodes.map(n => Number((n.y!).toFixed(1))))].sort((a, b) => a - b);
  const rankOf = new Map<number, number>();
  const ranks = ys.map((y, i) => {
    const ns = nodes.filter(n => Math.abs(n.y! - y) < 0.05);
    ns.forEach(n => rankOf.set(n.id, i));
    return ns;
  });
  return { rankOf, ranks };
}

// 计算背景盒所需填充（垂直按排、水平按节点），换算成 dagre 节点膨胀量。
// 垂直：rank r 的排带向上下各外扩 max(上方盒头需求, 下方盒底需求)，使相邻排间隙 ≥ 盒头+盒底需求；
// 水平：节点向左右各外扩其所属盒的左右外扩量，使同排相邻节点间隙 ≥ 两侧外扩之和。
function computePadding(
  nodes: GNode[],
  maxLayer: number,
  rankOf: Map<number, number>,
  ranks: GNode[][],
  omittedKeys: Set<string>
): { inflV: Map<number, number>; inflH: Map<number, number> } {
  // 背景盒定义（与 computePanels 同一套规则：省略纯传递前缀、单卡片纯嵌套盒）
  interface BoxDef {
    key: string;
    minRank: number;
    maxRank: number;
    inward: number;
    members: GNode[];
  }
  const defs: BoxDef[] = [];
  {
    const byKey = new Map<string, { key: string; members: GNode[] }>();
    for (const nd of nodes) {
      if (!nd.group || nd.kind === 'placeholder' || nd.kind === 'output') continue;
      const segs = nd.group.split('.').length;
      for (let layer = 1; layer <= Math.min(maxLayer, segs); layer++) {
        const key = nd.group.split('.').slice(0, layer).join('.');
        if (omittedKeys.has(key)) continue;
        if (nd.kind === 'module-cluster' && key === nd.group) continue;
        let d = byKey.get(key);
        if (!d) {
          d = { key, members: [] };
          byKey.set(key, d);
        }
        d.members.push(nd);
      }
    }
    for (const { key, members } of byKey.values()) {
      if (members.length === 1 && members[0].kind === 'module-cluster') continue;
      const rs = members.map(m => rankOf.get(m.id)!);
      defs.push({ key, minRank: Math.min(...rs), maxRank: Math.max(...rs), inward: 0, members });
    }
    const maxSegs = Math.max(0, ...defs.map(d => d.key.split('.').length));
    defs.forEach(d => (d.inward = maxSegs - d.key.split('.').length));
  }

  const inflV = new Map<number, number>();
  const inflH = new Map<number, number>();
  if (!defs.length) return { inflV, inflH };

  const topStack = (r: number) =>
    Math.max(0, ...defs.filter(d => d.minRank === r).map(d => PANEL_PAD + (d.inward + 1) * PANEL_HEADER));
  const bottomPad = (r: number) => Math.max(0, ...defs.filter(d => d.maxRank === r).map(d => PANEL_PAD + d.inward * 6));

  ranks.forEach((ns, r) => {
    // 该排上下各外扩 max(上邻排需求的盒头部分, 下邻排需求的盒底部分)，保证相邻排间隙足够
    const m = Math.max(topStack(r) + 4, bottomPad(r) + 4);
    if (m > 0) ns.forEach(n => inflV.set(n.id, 2 * m));
  });

  for (const d of defs) {
    // 每个盒在其成员所在排的最左/最右成员处外扩
    const byRank = new Map<number, GNode[]>();
    for (const m of d.members) {
      const r = rankOf.get(m.id)!;
      if (!byRank.has(r)) byRank.set(r, []);
      byRank.get(r)!.push(m);
    }
    for (const inRank of byRank.values()) {
      const leftmost = inRank.reduce((a, b) => (a.x! < b.x! ? a : b));
      const rightmost = inRank.reduce((a, b) => (a.x! + a.w! > b.x! + b.w! ? a : b));
      const ext = PANEL_PAD + d.inward * 6;
      inflH.set(leftmost.id, Math.max(inflH.get(leftmost.id) ?? 0, 2 * ext));
      inflH.set(rightmost.id, Math.max(inflH.get(rightmost.id) ?? 0, 2 * ext));
    }
  }
  return { inflV, inflH };
}

// 两遍（必要时三遍）dagre：第一遍量出填充需求，第二遍用膨胀尺寸重排；
// 若膨胀改变了排结构则再迭代一次直至收敛。布局后节点零位移，dagre 路由点原生有效。
function dagreWithPadding(
  nodes: GNode[],
  edges: GEdge[],
  opts: DagreOpts,
  maxLayer: number,
  omittedKeys: Set<string>
): { points: Map<string, Pt[]>; rankOf: Map<number, number> } {
  let inflV = new Map<number, number>();
  let inflH = new Map<number, number>();
  let points = new Map<string, Pt[]>();
  let rankOf = new Map<number, number>();
  for (let iter = 0; iter < 3; iter++) {
    const d = runDagre(nodes, edges, opts, inflV, inflH);
    for (const nd of nodes) {
      const c = d.pos.get(nd.id)!;
      nd.x = c.x - nd.w! / 2;
      nd.y = c.y - nd.h! / 2;
    }
    const rk = computeRanks(nodes);
    points = d.points;
    rankOf = rk.rankOf;
    const pad = computePadding(nodes, maxLayer, rk.rankOf, rk.ranks, omittedKeys);
    if (sameMap(pad.inflV, inflV) && sameMap(pad.inflH, inflH)) break;
    inflV = pad.inflV;
    inflH = pad.inflH;
  }
  return { points, rankOf };
}

function sameMap(a: Map<number, number>, b: Map<number, number>): boolean {
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const k of keys) if ((a.get(k) ?? 0) !== (b.get(k) ?? 0)) return false;
  return true;
}
