// TreePanel：左侧模块结构树（数据来自导出格式中的 tree 字段，图内算子按 group 补挂，支持关键字筛选）
import type { GNode, GraphData } from '../types';
import { esc, fmtNum, fmtShape } from '../utils';

function countTreeParams(nd: GNode): number {
  if (nd.params !== undefined) return nd.params;
  let t = 0;
  for (const c of nd.children || []) t += countTreeParams(c);
  return t;
}

export class TreePanel {
  // group 路径 → 该模块下的自由算子（call_function/call_method，如 cat、pad）及其图内执行序
  private ops = new Map<string, { nd: GNode; idx: number }[]>();
  // 路径 → 图执行序中首次出现位置（子模块/算子按数据流排序）
  private flow = new Map<string, number>();
  private data: GraphData | null = null;
  // 筛选关键字（小写）；空 = 不筛选
  private filter = '';
  private content: HTMLElement;

  constructor(
    private container: HTMLElement,
    private locate: (qname: string, isModule: boolean) => void
  ) {
    // 筛选输入框与树内容区一次性创建：重渲染只刷新内容区，输入框焦点与文本得以保留
    const input = document.createElement('input');
    input.className = 'tree-search';
    input.placeholder = '搜索筛选节点...';
    input.spellcheck = false;
    input.addEventListener('input', () => {
      this.filter = input.value.trim().toLowerCase();
      this.renderTree();
    });
    this.content = document.createElement('div');
    container.append(input, this.content);
  }

  render(data: GraphData): void {
    const root = data.tree;
    if (!root || data.kind === 'tree') {
      this.container.style.display = 'none';
      return;
    }
    this.data = data;
    this.ops = new Map();
    this.flow = new Map();
    const touch = (path: string, i: number): void => {
      const cur = this.flow.get(path);
      if (cur === undefined || i < cur) this.flow.set(path, i);
    };
    data.nodes.forEach((nd, i) => {
      if (nd.kind === 'placeholder' || nd.kind === 'output') return;
      if (nd.kind === 'call_function' || nd.kind === 'call_method') {
        const g = nd.group || '';
        let arr = this.ops.get(g);
        if (!arr) this.ops.set(g, (arr = []));
        arr.push({ nd, idx: i });
      }
      // group 与 call_module/get_attr 的 target 的各级前缀都记为首次触达
      const paths: string[] = [];
      if (nd.group) paths.push(nd.group);
      if ((nd.kind === 'call_module' || nd.kind === 'get_attr') && nd.target) paths.push(nd.target);
      for (const p of paths) {
        const segs = p.split('.');
        for (let k = 1; k <= segs.length; k++) touch(segs.slice(0, k).join('.'), i);
      }
    });
    this.container.style.display = '';
    this.renderTree();
  }

  // 按当前关键字重建树；命中的祖先链自动展开
  private renderTree(): void {
    this.content.innerHTML = '<div class="panel-title">模块结构</div>';
    const root = this.data?.tree;
    if (!root) return;
    const el = this.item(root, '', true);
    if (el) this.content.appendChild(el);
    if (this.filter && !this.content.querySelector('.tree-item, .tree-leaf')) {
      const empty = document.createElement('div');
      empty.className = 'tree-empty';
      empty.textContent = '无匹配节点';
      this.content.appendChild(empty);
    }
  }

  syncHighlight(nd: GNode | null): void {
    // 簇卡片用 clusterKey；模块调用用 target；普通算子用 fx 节点名
    const q = nd ? nd.clusterKey || (nd.kind === 'call_module' ? nd.target || nd.name : nd.name) : null;
    let hitRow: HTMLElement | null = null;
    for (const e of Array.from(this.content.querySelectorAll<HTMLElement>('[data-qname]'))) {
      const hit = q !== null && e.dataset.qname === q;
      e.classList.toggle('hl', hit);
      if (hit) hitRow = e;
    }
    // 展开祖先 details 并滚动到可见，保证反向联动（图 → 树）时高亮行不藏在折叠里
    if (hitRow) {
      let p = hitRow.parentElement;
      while (p && p !== this.content) {
        if (p.tagName === 'DETAILS') (p as HTMLDetailsElement).open = true;
        p = p.parentElement;
      }
      hitRow.scrollIntoView({ block: 'nearest' });
    }
  }

  // 筛选保留判定：自身命中（qname/名称/类名）或后代/挂载算子命中
  private kept(nd: GNode, qname: string): boolean {
    if (!this.filter) return true;
    const hay = `${qname} ${nd.name || ''} ${nd.cls || ''}`.toLowerCase();
    if (hay.includes(this.filter)) return true;
    if ((nd.children || []).some(k => this.kept(k, qname ? `${qname}.${k.name}` : k.name))) return true;
    return (this.ops.get(qname) || []).some(o => this.opKept(o.nd));
  }

  private opKept(nd: GNode): boolean {
    // 匹配范围：所属模块路径 + fx 节点名 + 算子名
    return `${nd.group || ''} ${nd.name} ${nd.cls || ''}`.toLowerCase().includes(this.filter);
  }

  // 文本转义并高亮命中片段（不区分大小写）
  private hi(text: string): string {
    const t = text || '';
    if (!this.filter) return esc(t);
    const out: string[] = [];
    const lower = t.toLowerCase();
    let i = 0;
    for (;;) {
      const j = lower.indexOf(this.filter, i);
      if (j < 0) {
        out.push(esc(t.slice(i)));
        break;
      }
      out.push(esc(t.slice(i, j)), `<mark>${esc(t.slice(j, j + this.filter.length))}</mark>`);
      i = j + this.filter.length;
    }
    return out.join('');
  }

  private item(nd: GNode, prefix: string, isRoot = false): HTMLElement | null {
    const qname = isRoot ? '' : prefix ? `${prefix}.${nd.name}` : nd.name || '';
    if (this.filter && !this.kept(nd, qname)) return null;
    const div = document.createElement('div');
    div.className = 'tree-item';
    const kids = nd.children || [];
    const ops = (this.ops.get(qname) || []).filter(o => this.opKept(o.nd));
    const hasMod = kids.some(k => k.children !== undefined) || ops.length > 0;
    if (hasMod) {
      const det = document.createElement('details');
      det.open = this.filter ? true : (prefix.match(/\./g) || []).length < 2;
      const sum = document.createElement('summary');
      sum.dataset.qname = qname;
      // 独立三角形：点击仅展开/折叠树节点（details 默认行为），不触发定位
      const caret = document.createElement('span');
      caret.className = 't-caret';
      const name = document.createElement('span');
      name.className = 't-name';
      name.innerHTML = this.hi(nd.name || '');
      const sub = document.createElement('span');
      sub.className = 't-sub';
      sub.innerHTML = `${this.hi(nd.cls || '')} · ${fmtNum(nd.params ?? countTreeParams(nd))}`;
      sum.append(caret, name, sub);
      sum.addEventListener('click', e => {
        if ((e.target as Element).classList.contains('t-caret')) return;
        e.preventDefault(); // 行点击：仅定位选中，不切换折叠
        this.locate(qname, true);
      });
      det.appendChild(sum);
      // 参数/缓冲保持在前；子模块与算子按图执行序（数据流）交错排列
      kids.filter(k => k.children === undefined).forEach(k => {
        const el = this.item(k, qname);
        if (el) det.appendChild(el);
      });
      const entries = [
        ...kids
          .filter(k => k.children !== undefined)
          .map(m => ({ mod: m as GNode, op: null as { nd: GNode; idx: number } | null, i: this.flow.get(qname ? `${qname}.${m.name}` : m.name) ?? Infinity })),
        ...ops.map(o => ({ mod: null as GNode | null, op: o as { nd: GNode; idx: number } | null, i: o.idx })),
      ];
      entries.sort((a, b) => a.i - b.i);
      for (const e of entries) {
        if (e.op) det.appendChild(this.opRow(e.op.nd));
        else {
          const el = this.item(e.mod!, qname);
          if (el) det.appendChild(el);
        }
      }
      div.appendChild(det);
    } else {
      const row = document.createElement('div');
      row.className = 'tree-leaf';
      row.dataset.qname = qname;
      const info = nd.shape ? ' ' + fmtShape(nd.shape) : '';
      row.innerHTML = `<span class="t-name">${this.hi(nd.name || '')}</span><span class="t-sub">${this.hi(nd.cls || '')}${esc(info)}</span>`;
      row.addEventListener('click', () => this.locate(qname, false));
      div.appendChild(row);
    }
    return div;
  }

  // 自由算子叶子：点击定位到全细节层的对应节点
  private opRow(nd: GNode): HTMLElement {
    const row = document.createElement('div');
    row.className = 'tree-leaf';
    row.dataset.qname = nd.name;
    const info = nd.out_shape ? ' ' + fmtShape(nd.out_shape) : '';
    row.innerHTML = `<span class="t-name">${this.hi(nd.cls || nd.name || '')}</span><span class="t-sub">${esc(info)}</span>`;
    row.addEventListener('click', () => this.locate(nd.name, false));
    return row;
  }
}
