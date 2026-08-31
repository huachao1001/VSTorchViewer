// TreePanel：左侧模块结构树（数据来自导出格式中的 tree 字段，图内算子按 group 补挂）
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

  constructor(
    private container: HTMLElement,
    private locate: (qname: string, isModule: boolean) => void
  ) {}

  render(data: GraphData): void {
    const root = data.tree;
    if (!root || data.kind === 'tree') {
      this.container.style.display = 'none';
      return;
    }
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
    this.container.innerHTML = '<div class="panel-title">模块结构</div>';
    // 根节点路径置空：子级 qname 从根的直接子模块开始，与图内 group/target 路径对齐
    this.container.appendChild(this.item(root, '', true));
  }

  syncHighlight(nd: GNode | null): void {
    // 簇卡片用 clusterKey；模块调用用 target；普通算子用 fx 节点名
    const q = nd ? nd.clusterKey || (nd.kind === 'call_module' ? nd.target || nd.name : nd.name) : null;
    let hitRow: HTMLElement | null = null;
    for (const e of Array.from(this.container.querySelectorAll<HTMLElement>('[data-qname]'))) {
      const hit = q !== null && e.dataset.qname === q;
      e.classList.toggle('hl', hit);
      if (hit) hitRow = e;
    }
    // 展开祖先 details 并滚动到可见，保证反向联动（图 → 树）时高亮行不藏在折叠里
    if (hitRow) {
      let p = hitRow.parentElement;
      while (p && p !== this.container) {
        if (p.tagName === 'DETAILS') (p as HTMLDetailsElement).open = true;
        p = p.parentElement;
      }
      hitRow.scrollIntoView({ block: 'nearest' });
    }
  }

  private item(nd: GNode, prefix: string, isRoot = false): HTMLElement {
    const qname = isRoot ? '' : prefix ? `${prefix}.${nd.name}` : nd.name || '';
    const div = document.createElement('div');
    div.className = 'tree-item';
    const kids = nd.children || [];
    const ops = this.ops.get(qname) || [];
    const hasMod = kids.some(k => k.children !== undefined) || ops.length > 0;
    if (hasMod) {
      const det = document.createElement('details');
      det.open = (prefix.match(/\./g) || []).length < 2;
      const sum = document.createElement('summary');
      sum.dataset.qname = qname;
      // 独立三角形：点击仅展开/折叠树节点（details 默认行为），不触发定位
      const caret = document.createElement('span');
      caret.className = 't-caret';
      const name = document.createElement('span');
      name.className = 't-name';
      name.textContent = nd.name || '';
      const sub = document.createElement('span');
      sub.className = 't-sub';
      sub.textContent = `${nd.cls || ''} · ${fmtNum(nd.params ?? countTreeParams(nd))}`;
      sum.append(caret, name, sub);
      sum.addEventListener('click', e => {
        if ((e.target as Element).classList.contains('t-caret')) return;
        e.preventDefault(); // 行点击：仅定位选中，不切换折叠
        this.locate(qname, true);
      });
      det.appendChild(sum);
      // 参数/缓冲保持在前；子模块与算子按图执行序（数据流）交错排列
      kids.filter(k => k.children === undefined).forEach(k => det.appendChild(this.item(k, qname)));
      const entries = [
        ...kids
          .filter(k => k.children !== undefined)
          .map(m => ({ mod: m as GNode, op: null as { nd: GNode; idx: number } | null, i: this.flow.get(qname ? `${qname}.${m.name}` : m.name) ?? Infinity })),
        ...ops.map(o => ({ mod: null as GNode | null, op: o as { nd: GNode; idx: number } | null, i: o.idx })),
      ];
      entries.sort((a, b) => a.i - b.i);
      for (const e of entries) det.appendChild(e.op ? this.opRow(e.op.nd) : this.item(e.mod!, qname));
      div.appendChild(det);
    } else {
      const row = document.createElement('div');
      row.className = 'tree-leaf';
      row.dataset.qname = qname;
      const info = nd.shape ? ' ' + fmtShape(nd.shape) : '';
      row.innerHTML = `<span class="t-name">${esc(nd.name || '')}</span><span class="t-sub">${esc(nd.cls || '')}${esc(info)}</span>`;
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
    row.innerHTML = `<span class="t-name">${esc(nd.cls || nd.name || '')}</span><span class="t-sub">${esc(info)}</span>`;
    row.addEventListener('click', () => this.locate(nd.name, false));
    return row;
  }
}
