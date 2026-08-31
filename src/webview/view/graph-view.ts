// GraphView：视图控制器
// 职责：视图变换（缩放/平移/适应）、渲染循环、交互事件、选中高亮、搜索
// 数据与布局全部委托给 GraphModel；SVG 构建委托给各 Renderer
import type { GNode, GraphData, Selection } from '../types';
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
  private searchHits = new Set<number>();
  private nodeRenderer = new NodeRenderer();
  private edgeRenderer = new EdgeRenderer();
  private panelRenderer = new PanelRenderer();
  private details: DetailsPanel;
  private tree: TreePanel;
  private fitting = false;
  // 缩放动画状态：目标缩放 + 锚点，rAF 指数趋近（地图式连续缩放）
  private zoomAnim: { target: number; ax: number; ay: number; last: number; raf: number } | null = null;

  constructor(
    private model: GraphModel,
    private c: Containers
  ) {
    this.details = new DetailsPanel(c.details);
    this.tree = new TreePanel(c.tree, qname => this.locateModule(qname));
  }

  // ---------- 数据入口 ----------

  onData(data: GraphData): void {
    this.model.load(data, this.view.k);
    const name = document.getElementById('model-name')!;
    name.textContent = (data.model || '') + (data.total_params !== undefined ? ` · ${fmtParams(data.total_params)}` : '');
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
    for (const ch of this.model.chains) this.c.edgesG.appendChild(this.edgeRenderer.build(ch, this.model.idx));
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
    this.c.nodesG.querySelectorAll('.node').forEach(g => {
      const nid = Number((g as SVGGElement).dataset.id);
      g.classList.toggle('sel', ids.has(nid));
      g.classList.toggle('dim', !!this.sel && !ids.has(nid));
    });
    this.c.panelsG.classList.toggle('dimmed', !!this.sel);
    this.c.edgesG.querySelectorAll('.edge').forEach(p => {
      const src = Number((p as SVGPathElement).dataset.src);
      const dst = Number((p as SVGPathElement).dataset.dst);
      const hl = ids.has(src) || ids.has(dst);
      p.classList.toggle('hl', hl);
      p.classList.toggle('dim', !!this.sel && !hl);
    });
    this.details.show(primary, this.model.data);
    this.tree.syncHighlight(primary);
  }

  locateModule(qname: string): void {
    const nd = this.model.nodes.find(n => n.kind === 'call_module' && (n.target === qname || n.name === qname));
    if (nd) {
      this.select(nd.id);
      this.centerOn(nd.id);
    }
  }

  // ---------- 视图变换 ----------

  private apply(): void {
    // 视图钳制：无论怎么缩放/平移，图的包围盒至少留 80px 在视口内，整图不会逃出可视范围
    const W = this.c.svg.clientWidth;
    const H = this.c.svg.clientHeight;
    if (W > 60 && H > 60) {
      const b = this.contentBounds();
      if (b) {
        // 弱钳制：仅在内容即将完全滑出视口时拉回（≥80px 交叠）。
        // 正常缩放区间不介入，保证缩放往返精确可逆（每步都是纯锚点变换）。
        const m = 80;
        const k = this.view.k;
        const x1 = this.view.tx + b.minX * k;
        const x2 = this.view.tx + b.maxX * k;
        const y1 = this.view.ty + b.minY * k;
        const y2 = this.view.ty + b.maxY * k;
        if (x2 < m) this.view.tx += m - x2;
        if (x1 > W - m) this.view.tx -= x1 - (W - m);
        if (y2 < m) this.view.ty += m - y2;
        if (y1 > H - m) this.view.ty -= y1 - (H - m);
      }
    }
    this.c.viewport.setAttribute(
      'transform',
      `translate(${this.view.tx.toFixed(1)} ${this.view.ty.toFixed(1)}) scale(${this.view.k.toFixed(4)})`
    );
  }

  // 当前内容的包围盒（节点 + 背景盒，世界坐标）
  private contentBounds(): { minX: number; maxX: number; minY: number; maxY: number } | null {
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    for (const nd of this.model.nodes) {
      if (nd.x === undefined) continue;
      minX = Math.min(minX, nd.x);
      maxX = Math.max(maxX, nd.x + (nd.w || 0));
      minY = Math.min(minY, nd.y!);
      maxY = Math.max(maxY, nd.y! + (nd.h || 0));
    }
    for (const p of this.model.panels) {
      minX = Math.min(minX, p.x!);
      maxX = Math.max(maxX, p.x! + p.w!);
      minY = Math.min(minY, p.yTop!);
      maxY = Math.max(maxY, p.yTop! + p.yH!);
    }
    return isFinite(minX) ? { minX, maxX, minY, maxY } : null;
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
    this.syncLevel();
  }

  // 测试钩子：立即完成进行中的缩放动画
  settle(): void {
    const z = this.zoomAnim;
    if (!z) return;
    cancelAnimationFrame(z.raf);
    this.zoomAnim = null;
    this.setK(z.target, z.ax, z.ay);
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
      this.syncLevel();
      if (this.model.level !== before) this.fit();
      this.fitting = false;
    }
  }

  // 缩放跨过阈值 → 切换层级：旧场景直接消失，新场景直接显示
  // 场景切换不改视图变换（缩放往返保持精确可逆）
  private syncLevel(): void {
    const target = this.model.zoomToLevel(this.view.k);
    if (target === this.model.level) return;
    this.model.setLevel(target);
    this.renderGraph();
    this.applySelection();
  }

  // ---------- 搜索 ----------

  private refreshHits(): void {
    this.c.nodesG.querySelectorAll('.node').forEach(g => g.classList.toggle('hit', this.searchHits.has(Number((g as SVGGElement).dataset.id))));
  }

  private onSearch(query: string): void {
    const q = query.trim().toLowerCase();
    const list = document.getElementById('search-list')!;
    this.searchHits.clear();
    if (!q) {
      list.innerHTML = '';
      this.refreshHits();
      return;
    }
    const hits = this.model.nodes.filter(
      n => !n.virtual && ((n.name || '') + ' ' + (n.cls || '') + ' ' + (n.target || '') + ' ' + (n.group || '')).toLowerCase().includes(q)
    );
    hits.slice(0, 10).forEach(n => this.searchHits.add(n.id));
    this.refreshHits();
    list.innerHTML = hits
      .slice(0, 10)
      .map(n => `<div class="search-item" data-id="${n.id}"><span>${escHtml(n.name || n.kind || '')}</span><span>${escHtml(n.cls || '')}</span></div>`)
      .join('');
  }

  // ---------- 交互 ----------

  init(): void {
    const svg = this.c.svg;
    svg.addEventListener(
      'wheel',
      e => {
        e.preventDefault();
        const r = svg.getBoundingClientRect();
        this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.pow(1.0015, -e.deltaY));
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
    document.getElementById('btn-zoom-in')!.addEventListener('click', () => this.zoomAt(svg.clientWidth / 2, svg.clientHeight / 2, 1.25));
    document.getElementById('btn-zoom-out')!.addEventListener('click', () => this.zoomAt(svg.clientWidth / 2, svg.clientHeight / 2, 0.8));
    document.getElementById('btn-fit')!.addEventListener('click', () => this.fit());
    const search = document.getElementById('search')! as HTMLInputElement;
    search.addEventListener('input', () => this.onSearch(search.value));
    const list = document.getElementById('search-list')!;
    list.addEventListener('click', e => {
      const it = (e.target as Element).closest('.search-item');
      if (!it) return;
      const id = Number((it as HTMLElement).dataset.id);
      this.select(id);
      this.centerOn(id);
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

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
