// GraphModel：数据模型核心
// 职责：层级计算（语义缩放）、模块折叠、dagre 布局、背景盒空间后处理、组合背景几何、选中解析
// 不接触 DOM；渲染层只读取它暴露的 nodes/idx/chains/panels
import dagre from '@dagrejs/dagre';
import type { Chain, GEdge, GNode, GraphData, Panel, Pt, ResolvedSelection, Selection } from './types';
import { sizeNode } from './node-metrics';

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
  // 纯传递前缀（只含 1 个子组合、自身无算子）→ 不显示背景盒；折叠时下钻到唯一孩子
  private omit = new Set<string>();
  private omitChild = new Map<string, string>();
  // 当前的排带（finalizeLayout 位移后的几何），供连线避障路由使用
  private bands: { top: number; bottom: number }[] = [];
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
      this.nodes = this.fullNodes;
      this.idx = new Map(this.nodes.map(n => [n.id, n]));
      this.finalizeLayout(Math.max(0, ...src.nodes.filter(n => n.group).map(n => n.group!.split('.').length)));
      this.alignToRef(); // finalize 会移动节点，重新对齐到固定参考中心
      this.chains = this.routeEdges(src.edges);
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

    // 紧凑 dagre 重排
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'TB', nodesep: 28, edgesep: 10, ranksep: 46, marginx: 0, marginy: 0 });
    g.setDefaultNodeLabel(() => ({}));
    g.setDefaultEdgeLabel(() => ({}));
    this.nodes.forEach(nd => g.setNode(String(nd.id), { width: nd.w!, height: nd.h! }));
    aggEdges.forEach(e => g.setEdge(String(e.src), String(e.dst)));
    dagre.layout(g);
    this.nodes.forEach(nd => {
      const pos = g.node(String(nd.id));
      nd.x = pos.x - nd.w! / 2;
      nd.y = pos.y - nd.h! / 2;
    });

    // 与全细节布局对齐（固定参考中心，层级间内容稳定，缩放往返可逆）
    this.alignToRef();

    // 先套背景盒预留空间，再做连线路由（保证箭头锚在位移后的节点边缘）
    this.finalizeLayout(depth - 1); // 折叠级：按父模块给拆开的成员套组合背景
    this.chains = this.routeEdges(aggEdges);
  }

  // ---------- 全细节布局（只算一次） ----------

  private layoutFull(): void {
    const data = this.data!;
    this.nodes = data.nodes.map(n => ({ ...n }));
    this.idx = new Map(this.nodes.map(n => [n.id, n]));
    this.nodes.forEach(nd => sizeNode(nd));

    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'TB', nodesep: 34, edgesep: 10, ranksep: 70, marginx: 0, marginy: 0 });
    g.setDefaultNodeLabel(() => ({}));
    g.setDefaultEdgeLabel(() => ({}));
    this.nodes.forEach(nd => g.setNode(String(nd.id), { width: nd.w!, height: nd.h! }));
    data.edges.forEach(e => g.setEdge(String(e.src), String(e.dst)));
    dagre.layout(g);

    this.nodes.forEach(nd => {
      const pos = g.node(String(nd.id));
      nd.x = pos.x - nd.w! / 2;
      nd.y = pos.y - nd.h! / 2;
    });
    this.fullNodes = this.nodes;
    this.fullIdx = this.idx;

    // 缓存全细节布局中心（finalize 之前，永不改变）
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

  // 把当前节点整体平移，使包围盒中心对齐 fullRef（跨层级内容稳定）
  private alignToRef(): void {
    if (!this.fullRef) return;
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
    if (!isFinite(x1)) return;
    const dx = this.fullRef.x - (x1 + x2) / 2;
    const dy = this.fullRef.y - (y1 + y2) / 2;
    this.nodes.forEach(nd => {
      nd.x! += dx;
      nd.y! += dy;
    });
  }

  // ---------- 布局后处理：为嵌套背景盒预留空间（盒内保持紧凑，只在盒边界处拉开间距） ----------

  private finalizeLayout(maxLayer: number): void {
    // 1) 排（rank）：dagre 同排节点的中心 y 相同
    const ys = [...new Set(this.nodes.map(n => Number((n.y!).toFixed(1))))].sort((a, b) => a - b);
    const rankOf = new Map<number, number>();
    const ranks = ys.map((y, i) => {
      const nodes = this.nodes.filter(n => Math.abs(n.y! - y) < 0.05);
      nodes.forEach(n => rankOf.set(n.id, i));
      return {
        idx: i,
        nodes,
        top: Math.min(...nodes.map(n => n.y!)),
        bottom: Math.max(...nodes.map(n => n.y! + n.h!)),
      };
    });

    // 2) 背景盒定义，并换算嵌套深度
    // 省略规则：纯传递前缀不套盒；盒内只有 1 张簇卡片（纯嵌套）也不套盒；含真实算子（哪怕 1 个）则保留
    interface BoxDef {
      key: string;
      segs: number;
      minRank: number;
      maxRank: number;
      inward: number;
      members: GNode[];
    }
    const defs: BoxDef[] = [];
    {
      const byKey = new Map<string, { key: string; members: GNode[] }>();
      for (const nd of this.nodes) {
        if (!nd.group || nd.kind === 'placeholder' || nd.kind === 'output') continue;
        const segs = nd.group.split('.').length;
        for (let layer = 1; layer <= Math.min(maxLayer, segs); layer++) {
          const key = nd.group.split('.').slice(0, layer).join('.');
          if (this.omit.has(key)) continue;
          if (nd.kind === 'module-cluster' && key === nd.group) continue; // 卡片自身不套盒
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
        defs.push({ key, segs: key.split('.').length, minRank: Math.min(...rs), maxRank: Math.max(...rs), inward: 0, members });
      }
      const maxSegs = Math.max(0, ...defs.map(d => d.segs));
      defs.forEach(d => (d.inward = maxSegs - d.segs));
    }

    // 3) 垂直：盒顶部标题条带堆叠 + 盒底部外扩，只加在盒边界相邻的排间距上
    const topStack = (r: number) =>
      Math.max(0, ...defs.filter(d => d.minRank === r).map(d => PANEL_PAD + (d.inward + 1) * PANEL_HEADER));
    const bottomPad = (r: number) => Math.max(0, ...defs.filter(d => d.maxRank === r).map(d => PANEL_PAD + d.inward * 6));
    for (let r = 0; r + 1 < ranks.length; r++) {
      const required = topStack(r + 1) + bottomPad(r) + 14;
      const actual = ranks[r + 1].top - ranks[r].bottom;
      if (actual < required) {
        const delta = required - actual;
        for (let rr = r + 1; rr < ranks.length; rr++) {
          ranks[rr].top += delta;
          ranks[rr].bottom += delta;
          ranks[rr].nodes.forEach(n => (n.y! += delta));
        }
      }
    }

    // 4) 水平：盒左右外扩只加在同排相邻、且分属不同盒的节点之间
    for (const rank of ranks) {
      const nodes = rank.nodes.slice().sort((a, b) => a.x! - b.x!);
      const leftExt = new Map<number, number>();
      const rightExt = new Map<number, number>();
      for (const d of defs) {
        const inRank = d.members.filter(m => rankOf.get(m.id) === rank.idx);
        if (!inRank.length) continue;
        const leftmost = inRank.reduce((a, b) => (a.x! < b.x! ? a : b));
        const rightmost = inRank.reduce((a, b) => (a.x! + a.w! > b.x! + b.w! ? a : b));
        leftExt.set(leftmost.id, Math.max(leftExt.get(leftmost.id) ?? 0, PANEL_PAD + d.inward * 6));
        rightExt.set(rightmost.id, Math.max(rightExt.get(rightmost.id) ?? 0, PANEL_PAD + d.inward * 6));
      }
      let delta = 0;
      let prevRight = -Infinity;
      let prevExt = 0;
      for (const n of nodes) {
        const le = leftExt.get(n.id) ?? 0;
        if (prevRight === -Infinity) {
          n.x = n.x!;
        } else {
          const need = prevRight + prevExt + 18 + le;
          const x = Math.max(n.x! + delta, need);
          delta = x - n.x!;
          n.x = x;
        }
        prevRight = n.x! + n.w!;
        prevExt = rightExt.get(n.id) ?? 0;
      }
    }

    // 记录位移后的排带几何，供连线避障路由使用
    this.bands = ranks.map(r => ({ top: r.top, bottom: r.bottom }));
    this.rankOf = rankOf;

    this.computePanels(maxLayer); // 最终几何由位移后的成员位置决定
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

  // ---------- 连线路由：在 finalizeLayout 之后进行，箭头始终锚在节点边缘 ----------
  // 垂直穿越每排时做避障检查，被节点挡住就在排间空隙里水平绕开；回边自下而上同样处理

  private routeEdges(edges: GEdge[]): Chain[] {
    const chains: Chain[] = [];
    if (!this.bands.length) return chains;
    // 每排的避障矩形（外扩少许，保证线不贴节点）
    const bandRects = this.bands.map((_, i) =>
      this.nodes
        .filter(n => this.rankOf.get(n.id) === i)
        .map(n => ({ x1: n.x! - 3, x2: n.x! + n.w! + 3, y1: n.y! - 2, y2: n.y! + n.h! + 2 }))
    );
    const cx = (n: GNode) => n.x! + n.w! / 2;
    const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

    for (const e of edges) {
      const s = this.idx.get(e.src);
      const t = this.idx.get(e.dst);
      if (!s || !t) continue;
      const rs = this.rankOf.get(s.id) ?? 0;
      const rt = this.rankOf.get(t.id) ?? 0;
      const path: Pt[] = [];
      let dashed = false;

      if (rt === rs) {
        // 同排：水平直连
        if (cx(t) >= cx(s)) {
          path.push({ x: s.x! + s.w!, y: s.y! + s.h! / 2 }, { x: t.x!, y: t.y! + t.h! / 2 });
        } else {
          path.push({ x: s.x!, y: s.y! + s.h! / 2 }, { x: t.x! + t.w!, y: t.y! + t.h! / 2 });
        }
      } else if (Math.abs(rt - rs) === 1) {
        // 相邻排：Netron 风格平滑 S 曲线（始终落在两排之间的空隙里，不会穿过节点）
        if (rt > rs) {
          path.push({ x: cx(s), y: s.y! + s.h! }, { x: cx(t), y: t.y! });
        } else {
          dashed = true;
          path.push({ x: cx(s), y: s.y! }, { x: cx(t), y: t.y! + t.h! });
        }
      } else if (rt > rs) {
        // 跨多排向下：逐排穿越，必要时在排间空隙水平绕行
        let x = cx(s);
        path.push({ x, y: s.y! + s.h! });
        for (let r = rs + 1; r <= rt; r++) {
          const gapY = (this.bands[r - 1].bottom + this.bands[r].top) / 2;
          if (r === rt) {
            const tx = clamp(cx(t), t.x! + 10, t.x! + t.w! - 10);
            if (Math.abs(tx - x) > 0.5) path.push({ x, y: gapY }, { x: tx, y: gapY });
            path.push({ x: tx, y: t.y! });
          } else if (!this.columnClear(x, bandRects[r])) {
            const nx = this.nearestClearX(x, bandRects[r]);
            path.push({ x, y: gapY }, { x: nx, y: gapY });
            x = nx;
          }
        }
      } else {
        // 跨多排回边（向上）：自下而上，同样的避障策略
        dashed = true;
        let x = cx(s);
        path.push({ x, y: s.y! });
        for (let r = rs - 1; r >= rt; r--) {
          const gapY = (this.bands[r].bottom + this.bands[r + 1].top) / 2;
          if (r === rt) {
            const tx = clamp(cx(t), t.x! + 10, t.x! + t.w! - 10);
            if (Math.abs(tx - x) > 0.5) path.push({ x, y: gapY }, { x: tx, y: gapY });
            path.push({ x: tx, y: t.y! + t.h! });
          } else if (!this.columnClear(x, bandRects[r])) {
            const nx = this.nearestClearX(x, bandRects[r]);
            path.push({ x, y: gapY }, { x: nx, y: gapY });
            x = nx;
          }
        }
      }
      chains.push({ src: e.src, dst: e.dst, path, dashed });
    }
    return chains;
  }

  // 垂直穿越第 r 排在 x 处是否无阻挡
  private columnClear(x: number, rects: { x1: number; x2: number }[]): boolean {
    return !rects.some(rc => x > rc.x1 && x < rc.x2);
  }

  // 第 r 排中离 x 最近的可用通道（留在矩形间隙内，距边 6px）
  private nearestClearX(x: number, rects: { x1: number; x2: number }[]): number {
    const sorted = rects.slice().sort((a, b) => a.x1 - b.x1);
    const intervals: [number, number][] = [];
    let prev = -Infinity;
    for (const rc of sorted) {
      if (rc.x1 > prev) intervals.push([prev, rc.x1]);
      prev = Math.max(prev, rc.x2);
    }
    intervals.push([prev, Infinity]);
    let best = x;
    let bestD = Infinity;
    for (const [a, b] of intervals) {
      if (b - a < 14) continue;
      const c = Math.min(Math.max(x, a + 7), b - 7);
      const d = Math.abs(c - x);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
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
