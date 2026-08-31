// GraphView：视图控制器
// 职责：视图变换（缩放/平移/适应）、渲染循环、交互事件、选中高亮、搜索
// 数据与布局全部委托给 GraphModel；SVG 构建委托给各 Renderer
import type { GNode, GraphData, Panel, Pt, Selection } from '../types';
import { clamp, FONT_NAME } from '../utils';
import { K_MIN, GraphModel } from '../graph-model';
import { NodeRenderer } from '../render/node-renderer';
import { EdgeRenderer } from '../render/edge-renderer';
import { PanelRenderer } from '../render/panel-renderer';
import { renderLegend } from '../render/legend';
import { DetailsPanel } from '../sidebar/details-panel';
import { TreePanel } from '../sidebar/tree-panel';

interface Containers {
  svg: SVGSVGElement;
  viewport: SVGGElement;
  panelsG: SVGGElement;
  edgesG: SVGGElement;
  nodesG: SVGGElement;
  graphArea: HTMLElement;
  details: HTMLElement;
  tree: HTMLElement;
}

export class GraphView {
  private view = { k: 1, tx: 40, ty: 40 };
  private sel: Selection | null = null;
  private nodeRenderer = new NodeRenderer();
  private edgeRenderer = new EdgeRenderer();
  private panelRenderer = new PanelRenderer();
  private details: DetailsPanel;
  private tree: TreePanel;
  private fitting = false;
  // 缩放动画状态：目标缩放 + 锚点，rAF 指数趋近（地图式连续缩放）
  private zoomAnim: { target: number; ax: number; ay: number; last: number; raf: number } | null = null;
  // 跨级比例映射记忆：展开时记录（卡片 bbox ↔ 成员区域 bbox），收拢时用于精确逆映射
  private maps: { from: number; to: number; Bc: Rect; Bf: Rect }[] = [];

  constructor(
    private model: GraphModel,
    private c: Containers
  ) {
    this.details = new DetailsPanel(c.details);
    this.tree = new TreePanel(c.tree, (qname, isModule) => this.locateTree(qname, isModule));
  }

  // ---------- 数据入口 ----------

  onData(data: GraphData): void {
    this.model.load(data, this.view.k);
    if (data.kind === 'tree') this.renderTreeMode();
    else this.renderGraph();
    this.tree.render(data);
    this.details.show(null, data);
    setTimeout(() => this.fit(), 0);
  }

  // ---------- 渲染 ----------

  private renderGraph(): void {
    this.panelRenderer.render(this.model.panels, this.c.panelsG);
    this.renderEdges();
    this.renderNodes();
    renderLegend(this.model.nodes, this.c.graphArea);
    this.apply();
  }

  private renderNodes(): void {
    this.c.nodesG.innerHTML = '';
    for (const nd of this.model.nodes) {
      this.c.nodesG.appendChild(this.nodeRenderer.build(nd));
    }
  }

  private renderEdges(): void {
    this.c.edgesG.innerHTML = '';
    const seen = new Set<string>();
    for (const ch of this.model.chains) {
      // 两节点之间只绘制一条连线（不区分方向）
      const key = ch.src < ch.dst ? `${ch.src}:${ch.dst}` : `${ch.dst}:${ch.src}`;
      if (seen.has(key)) continue;
      seen.add(key);
      this.c.edgesG.appendChild(this.edgeRenderer.build(ch, this.model.idx));
    }
  }

  // 符号追踪失败的回退：模块树视图
  private renderTreeMode(): void {
    const root = this.model.prepareTreeFallback();
    if (!root) return;
    this.c.panelsG.innerHTML = '';
    this.c.edgesG.innerHTML = '';
    this.c.nodesG.innerHTML = '';
    const walk = (nd: GNode, parent: GNode | null): void => {
      if (parent) {
        const px = parent.x! + parent.w!;
        const py = parent.y! + parent.h! / 2;
        const cx = nd.x!;
        const cy = nd.y! + nd.h! / 2;
        const mx = px + (cx - px) / 2;
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', `M ${px} ${py} L ${mx} ${py} L ${mx} ${cy} L ${cx} ${cy}`);
        path.setAttribute('fill', 'none');
        path.setAttribute('class', 'edge');
        this.c.edgesG.appendChild(path);
      }
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'node');
      g.style.transform = `translate(${nd.x!.toFixed(1)}px, ${nd.y!.toFixed(1)}px)`;
      g.dataset.id = String(nd.id);
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('width', String(nd.w!));
      rect.setAttribute('height', String(nd.h!));
      rect.setAttribute('rx', '8');
      rect.setAttribute('class', 'card');
      g.appendChild(rect);
      const t1 = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t1.setAttribute('x', '12');
      t1.setAttribute('y', '18');
      t1.setAttribute('class', 'n-name');
      t1.style.font = FONT_NAME;
      t1.textContent = nd.name || '';
      g.appendChild(t1);
      const t2 = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t2.setAttribute('x', '12');
      t2.setAttribute('y', '34');
      t2.setAttribute('class', 'n-sub');
      t2.style.font = '10.5px Consolas, "Courier New", monospace';
      const hasKids = (nd.children || []).length > 0;
      const info = hasKids
        ? `${nd.cls || ''} · ${fmtParams(countParams(nd))}`
        : `${fmtShapeText(nd.shape)}${nd.dtype ? ' · ' + nd.dtype.replace('torch.', '') : ''}`;
      t2.textContent = info;
      g.appendChild(t2);
      this.c.nodesG.appendChild(g);
      (nd.children || []).forEach(k => walk(k, nd));
    };
    walk(root, null);
    renderLegend(this.model.nodes, this.c.graphArea);
    this.apply();
  }

  // ---------- 选中 ----------

  select(id: number): void {
    const nd = id >= 0 ? this.model.idx.get(id) : undefined;
    this.sel = nd ? { id, group: nd.group ?? null, isCluster: nd.kind === 'module-cluster' } : null;
    this.applySelection();
  }

  private applySelection(): void {
    const { ids, primary } = this.model.resolveSelection(this.sel);
    // 选中节点在当前层级解析不到（如未分组算子被折叠进卡片）→ 不置灰全图，避免缩放时"整图消失"
    const dim = !!this.sel && ids.size > 0;
    this.c.nodesG.querySelectorAll('.node').forEach(g => {
      const nid = Number((g as SVGGElement).dataset.id);
      g.classList.toggle('sel', ids.has(nid));
      g.classList.toggle('dim', dim && !ids.has(nid));
    });
    // 组合背景块联动：选中的面板保持自带紫色（仅从置灰恢复），其余继续置灰
    const hlKeys = this.highlightedPanelKeys(ids, primary);
    this.c.panelsG.querySelectorAll('[data-key]').forEach(el => {
      const k = (el as SVGElement).dataset.key!;
      el.classList.toggle('dim', dim && !hlKeys.has(k));
    });
    this.c.edgesG.querySelectorAll('.edge').forEach(p => {
      const src = Number((p as SVGPathElement).dataset.src);
      const dst = Number((p as SVGPathElement).dataset.dst);
      const hl = ids.has(src) || ids.has(dst);
      p.classList.toggle('hl', hl);
      p.classList.toggle('dim', dim && !hl);
    });
    this.details.show(primary, this.model.data);
    this.tree.syncHighlight(primary);
  }

  // 选中态对应的组合背景块 key 集合
  private highlightedPanelKeys(ids: Set<number>, primary: GNode | null): Set<string> {
    const keys = new Set<string>();
    if (this.sel?.isCluster && this.sel.group) {
      keys.add(this.sel.group);
      return keys;
    }
    if (!primary) return keys;
    let best: Panel | null = null;
    let bestA = Infinity;
    for (const p of this.model.panels) {
      if (!p.nodes.some(n => ids.has(n.id))) continue;
      const a = p.w! * p.yH!;
      if (a < bestA) {
        bestA = a;
        best = p;
      }
    }
    if (best) keys.add(best.key);
    return keys;
  }

  // 树 → 图联动：自动切换到能显示目标节点的层级（展开/折叠），选中并居中
  private locateTree(qname: string, isModule: boolean): void {
    if (this.model.data?.kind === 'tree') return;
    const segs = qname.split('.').filter(Boolean);
    if (!segs.length) {
      this.fit(); // 根节点：整体适配
      return;
    }
    const d = segs.length;
    const lv = this.model.levels;

    // 模块 → 该深度的层级；无直属算子（该深度不在层级表）→ 更深一级展示其子级
    // 叶子算子 → 全细节层
    let li: number;
    if (isModule) {
      li = lv.indexOf(d);
      if (li < 0) li = lv.findIndex(x => x > d);
      if (li < 0) li = lv.length - 1;
    } else {
      li = lv.length - 1;
    }
    if (this.model.level !== li) {
      this.model.setLevel(li);
      // 同步缩放值到该层级的带宽中点，否则下一次滚轮缩放会被 syncLevel 弹回原层级
      this.view.k = this.kForLevel(li);
      this.renderGraph();
    }

    // 目标节点：簇卡片（模块，被省略的前缀下钻到子卡片）→ 按名称/分组匹配
    let nd =
      this.model.nodes.find(n => n.clusterKey === qname) ??
      this.model.nodes.find(n => n.clusterKey && n.clusterKey.startsWith(qname + '.'));
    if (!nd) {
      nd = this.model.nodes.find(
        n => !n.virtual && ((n.kind === 'call_module' && (n.target === qname || n.name === qname)) || n.group === qname || n.name === qname)
      );
    }
    if (!nd) {
      // 参数/缓冲等叶子在图中无对应节点 → 回退到父模块
      const parent = segs.slice(0, -1).join('.');
      if (parent) {
        this.locateTree(parent, true);
      }
      return;
    }
    this.select(nd.id);
    this.centerOn(nd.id);
  }

  // 让 view.k 与程序化层级切换保持一致（否则下一次滚轮缩放会被 syncLevel 弹回）
  private kForLevel(li: number): number {
    const step = (1.5 - K_MIN) / Math.max(1, this.model.levels.length - 1);
    return clamp(K_MIN + (li + 0.5) * step, K_MIN, 8);
  }

  // ---------- 视图变换 ----------

  private apply(): void {
    this.c.viewport.setAttribute(
      'transform',
      `translate(${this.view.tx.toFixed(1)} ${this.view.ty.toFixed(1)}) scale(${this.view.k.toFixed(4)})`
    );
  }

  private zoomAt(mx: number, my: number, factor: number): void {
    const target = clamp((this.zoomAnim?.target ?? this.view.k) * factor, K_MIN, 8);
    if (this.zoomAnim) {
      // 连续滚动：更新目标与锚点，动画继续
      this.zoomAnim.target = target;
      this.zoomAnim.ax = mx;
      this.zoomAnim.ay = my;
      return;
    }
    this.zoomAnim = { target, ax: mx, ay: my, last: performance.now(), raf: 0 };
    this.zoomAnim.raf = requestAnimationFrame(this.zoomFrame);
  }

  // 每帧：当前缩放向目标指数趋近，锚点保持不动
  private zoomFrame = (t: number): void => {
    const z = this.zoomAnim;
    if (!z) return;
    const dt = Math.min(64, Math.max(1, t - z.last));
    z.last = t;
    const diff = z.target - this.view.k;
    if (Math.abs(diff) < 0.0015) {
      this.setK(z.target, z.ax, z.ay);
      cancelAnimationFrame(z.raf);
      this.zoomAnim = null;
      return;
    }
    // 时间常数 ~60ms 的指数平滑
    this.setK(this.view.k + diff * (1 - Math.exp(-dt / 60)), z.ax, z.ay);
    z.raf = requestAnimationFrame(this.zoomFrame);
  };

  // 立即应用某个缩放值（锚点不变）；k → level 的跨界在此触发场景切换
  private setK(k: number, ax: number, ay: number): void {
    const r = k / this.view.k;
    this.view.tx = ax - (ax - this.view.tx) * r;
    this.view.ty = ay - (ay - this.view.ty) * r;
    this.view.k = k;
    this.apply();
    this.syncLevel(ax, ay);
  }

  // 测试钩子：立即完成进行中的缩放动画
  settle(): void {
    const z = this.zoomAnim;
    if (!z) return;
    cancelAnimationFrame(z.raf);
    this.zoomAnim = null;
    this.setK(z.target, z.ax, z.ay);
  }

  // 竖向滚动的平移钳制：内容装得下视口时整体保持在窗口内，装不下时至少保留可见
  private clampTy(ty: number): number {
    const nodes = this.model.nodes;
    if (!nodes.length) return ty;
    let minY = Infinity,
      maxY = -Infinity;
    for (const nd of nodes) {
      if (nd.x === undefined) continue;
      minY = Math.min(minY, nd.y!);
      maxY = Math.max(maxY, nd.y! + (nd.h || 0));
    }
    for (const p of this.model.panels) {
      minY = Math.min(minY, p.yTop!);
      maxY = Math.max(maxY, p.yTop! + p.yH!);
    }
    if (!isFinite(minY)) return ty;
    const k = this.view.k;
    const H = this.c.svg.clientHeight;
    if (k * (maxY - minY) <= H) return clamp(ty, -k * minY, H - k * maxY);
    return clamp(ty, -k * maxY, H - k * minY);
  }

  private centerOn(id: number): void {
    const nd = this.model.idx.get(id);
    if (!nd || nd.x === undefined) return;
    const cx = nd.x + (nd.w || 0) / 2;
    const cy = (nd.y || 0) + (nd.h || 0) / 2;
    this.view.tx = this.c.svg.clientWidth / 2 - this.view.k * cx;
    this.view.ty = this.c.svg.clientHeight / 2 - this.view.k * cy;
    this.apply();
  }

  fit(): void {
    const nodes = this.model.nodes;
    if (!nodes.length) return;
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    for (const nd of nodes) {
      if (nd.x === undefined) continue;
      minX = Math.min(minX, nd.x);
      maxX = Math.max(maxX, nd.x + (nd.w || 0));
      minY = Math.min(minY, nd.y!);
      maxY = Math.max(maxY, nd.y! + (nd.h || 0));
    }
    if (!isFinite(minX)) return;
    for (const p of this.model.panels) {
      minY = Math.min(minY, p.yTop!);
      maxY = Math.max(maxY, p.yTop! + p.yH!);
    }
    const bw = Math.max(1, maxX - minX);
    const bh = Math.max(1, maxY - minY);
    const W = this.c.svg.clientWidth;
    const H = this.c.svg.clientHeight;
    this.view.k = clamp(Math.min((W - 60) / bw, (H - 80) / bh), K_MIN, 1.4);
    this.view.tx = (W - bw * this.view.k) / 2 - minX * this.view.k;
    this.view.ty = (H - bh * this.view.k) / 2 - minY * this.view.k;
    this.apply();
    // 当前层级装不下 → 切更粗层级后重新适配
    if (!this.fitting) {
      this.fitting = true;
      const before = this.model.level;
      this.syncLevel(this.c.svg.clientWidth / 2, this.c.svg.clientHeight / 2);
      if (this.model.level !== before) this.fit();
      this.fitting = false;
    }
  }

  // 缩放跨过阈值 → 切换层级：旧场景直接消失，新场景直接显示
  // 跨级比例映射：展开时记录（粗层级卡片 bbox ↔ 细层级成员区域 bbox），
  // 鼠标在卡片内的相对位置映射到成员区域的同一相对位置（鼠标下的子节点确定）；
  // 收拢时若鼠标仍在记录区域内，用同一对 bbox 做逆映射——静态鼠标下往返精确可逆。
  // 鼠标不在节点上但在组合区域内时，用组合窗口矩形 ↔ 收拢卡片 bbox 做同样的比例锁定
  private syncLevel(ax: number, ay: number): void {
    const target = this.model.zoomToLevel(this.view.k);
    if (target === this.model.level) return;
    const zoomIn = target > this.model.level;
    // 纯锚点缩放下鼠标世界点不变
    const w: Pt = { x: (ax - this.view.tx) / this.view.k, y: (ay - this.view.ty) / this.view.k };
    const prevLevel = this.model.level;

    if (zoomIn) {
      const coarseNodes = this.model.nodes.slice();
      const hit = this.nodeIn(coarseNodes, w);
      const isCluster = !!hit && hit.kind === 'module-cluster' && !!hit.clusterKey;
      // 参考窗口优先级：簇卡片 / 普通节点（IO 跨层级同 id）/ 最小包含组合区域
      const panel = hit ? null : this.smallestPanelAt(w);
      const Bc = hit ? nodeRect(hit) : panel?.rect ?? null;
      this.model.setLevel(target);
      this.renderGraph();
      const K = isCluster ? hit!.clusterKey! : panel?.key;
      const Bf = isCluster
        ? bboxOf(
            this.model.nodes.filter(
              nd =>
                nd.clusterKey === K ||
                (nd.clusterKey && nd.clusterKey.startsWith(K! + '.')) ||
                (nd.group && (nd.group === K || nd.group.startsWith(K! + '.')))
            )
          )
        : hit
          ? nodeRect(this.model.idx.get(hit.id))
          : panel
            ? bboxOf(this.model.nodes.filter(nd => nd.group && (nd.group === panel.key || nd.group.startsWith(panel.key + '.'))))
            : null;
      if (Bc && Bf && Bc.x2 - Bc.x1 >= 1 && Bc.y2 - Bc.y1 >= 1) {
        this.applyAnchor(ax, ay, mapRel(w, Bc, Bf));
        // 记录本次跨级映射（供收拢时逆映射）；同层级对去重即可——各层级几何确定，记录不会失效
        this.maps = this.maps.filter(m => !(m.from === prevLevel && m.to === target));
        this.maps.push({ from: prevLevel, to: target, Bc, Bf });
        if (this.maps.length > 16) this.maps.shift();
      }
    } else {
      const fineNodes = this.model.nodes.slice();
      const hit = this.nodeIn(fineNodes, w);
      // 细层级组合区域需在 setLevel 前捕获（renderGraph 后 panels 已是粗层级）
      const panel = hit ? null : this.smallestPanelAt(w);
      const ei = this.maps.findIndex(m => m.from === target && m.to === prevLevel && inRect(w, m.Bf));
      this.model.setLevel(target);
      this.renderGraph();
      if (ei >= 0) {
        const m = this.maps[ei];
        this.maps.splice(ei, 1);
        this.applyAnchor(ax, ay, mapRel(w, m.Bf, m.Bc));
      } else if (hit) {
        const isCluster = hit.kind === 'module-cluster' && !!hit.clusterKey;
        const Bf = nodeRect(hit);
        // 收拢目标：IO 节点跨层级同 id；普通算子 → 其所属簇卡片（clusterKey 为 group 的最长前缀）
        const Bc = isCluster
          ? bboxOf(
              this.model.nodes.filter(nd => nd.clusterKey && (nd.clusterKey === hit!.clusterKey || nd.clusterKey.startsWith(hit!.clusterKey! + '.')))
            )
          : nodeRect(this.model.idx.get(hit.id) ?? this.cardOf(hit));
        if (Bc && Bf && Bc.x2 - Bc.x1 >= 1 && Bc.y2 - Bc.y1 >= 1) {
          this.applyAnchor(ax, ay, mapRel(w, Bf, Bc));
        }
      } else if (panel) {
        const K = panel.key;
        const Bc = bboxOf(
          this.model.nodes.filter(nd => nd.clusterKey && (nd.clusterKey === K || nd.clusterKey.startsWith(K + '.')))
        );
        if (Bc && Bc.x2 - Bc.x1 >= 1 && Bc.y2 - Bc.y1 >= 1) {
          this.applyAnchor(ax, ay, mapRel(w, panel.rect, Bc));
        }
      }
    }
    this.applySelection();
  }

  // 包含世界点 w 的最小组合区域（背景矩形）；无则返回 null
  private smallestPanelAt(w: Pt): { key: string; rect: Rect } | null {
    let best: { key: string; rect: Rect } | null = null;
    let bestA = Infinity;
    for (const p of this.model.panels) {
      if (p.x === undefined) continue;
      const r: Rect = { x1: p.x, x2: p.x + p.w!, y1: p.yTop!, y2: p.yTop! + p.yH! };
      if (!inRect(w, r)) continue;
      const a = (r.x2 - r.x1) * (r.y2 - r.y1);
      if (a < bestA) {
        bestA = a;
        best = { key: p.key, rect: r };
      }
    }
    return best;
  }

  // 细层级节点收拢后所属的簇卡片（clusterKey 为 group 的最长前缀匹配）
  private cardOf(nd: GNode): GNode | undefined {
    if (!nd.group) return undefined;
    let best: GNode | undefined;
    let bestLen = -1;
    for (const c of this.model.nodes) {
      if (!c.clusterKey) continue;
      if (nd.group === c.clusterKey || nd.group.startsWith(c.clusterKey + '.')) {
        if (c.clusterKey.length > bestLen) {
          bestLen = c.clusterKey.length;
          best = c;
        }
      }
    }
    return best;
  }

  // 把视图平移到使世界点 w2 位于缩放锚点 (ax, ay) 下
  private applyAnchor(ax: number, ay: number, w2: Pt): void {
    this.view.tx = ax - this.view.k * w2.x;
    this.view.ty = ay - this.view.k * w2.y;
    this.apply();
  }

  // 节点列表中的最上层命中
  private nodeIn(nodes: GNode[], w: Pt): GNode | null {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const nd = nodes[i];
      if (nd.x === undefined) continue;
      if (w.x >= nd.x && w.x <= nd.x + (nd.w || 0) && w.y >= nd.y! && w.y <= nd.y! + (nd.h || 0)) return nd;
    }
    return null;
  }

  // ---------- 交互 ----------

  init(): void {
    const svg = this.c.svg;
    svg.addEventListener(
      'wheel',
      e => {
        e.preventDefault();
        const r = svg.getBoundingClientRect();
        const mx = e.clientX - r.left;
        const my = e.clientY - r.top;
        const w: Pt = { x: (mx - this.view.tx) / this.view.k, y: (my - this.view.ty) / this.view.k };
        // 仅在节点或组合区域（背景矩形）上响应缩放；空白处滚轮改为上下滚动
        if (this.nodeIn(this.model.nodes, w) || this.smallestPanelAt(w)) {
          this.zoomAt(mx, my, Math.pow(1.0015, -e.deltaY));
        } else {
          this.view.ty = this.clampTy(this.view.ty - e.deltaY);
          this.apply();
        }
      },
      { passive: false }
    );
    let pan: { x: number; y: number; tx: number; ty: number; moved: boolean } | null = null;
    svg.addEventListener('pointerdown', e => {
      if ((e.target as Element).closest('.node')) return;
      pan = { x: e.clientX, y: e.clientY, tx: this.view.tx, ty: this.view.ty, moved: false };
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener('pointermove', e => {
      if (!pan) return;
      const dx = e.clientX - pan.x;
      const dy = e.clientY - pan.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) pan.moved = true;
      this.view.tx = pan.tx + dx;
      this.view.ty = pan.ty + dy;
      this.apply();
    });
    svg.addEventListener('pointerup', () => {
      const was = pan;
      pan = null;
      if (was && !was.moved) this.select(-1);
    });
    this.c.nodesG.addEventListener('pointerdown', e => {
      const g = (e.target as Element).closest('.node');
      if (!g) return;
      e.stopPropagation();
      this.select(Number((g as SVGGElement).dataset.id));
    });
  }
}

// ---------- 模块级辅助 ----------

function countParams(nd: GNode): number {
  if (nd.params !== undefined) return nd.params;
  let t = 0;
  for (const c of nd.children || []) t += countParams(c);
  return t;
}

function fmtParams(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function fmtShapeText(s?: number[]): string {
  return s && s.length ? '[' + s.join(', ') + ']' : '';
}

// 节点集合的世界包围盒；空集合返回 null
function bboxOf(nodes: GNode[]): { x1: number; x2: number; y1: number; y2: number } | null {
  let x1 = Infinity,
    x2 = -Infinity,
    y1 = Infinity,
    y2 = -Infinity;
  for (const nd of nodes) {
    if (nd.x === undefined) continue;
    x1 = Math.min(x1, nd.x);
    x2 = Math.max(x2, nd.x + (nd.w || 0));
    y1 = Math.min(y1, nd.y!);
    y2 = Math.max(y2, nd.y! + (nd.h || 0));
  }
  return isFinite(x1) ? { x1, x2, y1, y2 } : null;
}

type Rect = { x1: number; x2: number; y1: number; y2: number };

// 单个节点的世界矩形；坐标缺失返回 null
function nodeRect(nd?: GNode): Rect | null {
  if (!nd || nd.x === undefined) return null;
  return { x1: nd.x, x2: nd.x + (nd.w || 0), y1: nd.y!, y2: nd.y! + (nd.h || 0) };
}

function inRect(w: Pt, r: Rect): boolean {
  return w.x >= r.x1 && w.x <= r.x2 && w.y >= r.y1 && w.y <= r.y2;
}

// 相对位置映射：w 在 from 内的相对位置 → to 内同一相对位置（钳制到边界内）
function mapRel(w: Pt, from: Rect, to: Rect): Pt {
  const rx = clamp((w.x - from.x1) / (from.x2 - from.x1), 0, 1);
  const ry = clamp((w.y - from.y1) / (from.y2 - from.y1), 0, 1);
  return { x: to.x1 + rx * (to.x2 - to.x1), y: to.y1 + ry * (to.y2 - to.y1) };
}
