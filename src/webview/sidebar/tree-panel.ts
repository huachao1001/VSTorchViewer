// TreePanel：左侧模块结构树（数据来自导出格式中的 tree 字段）
import type { GNode, GraphData } from '../types';
import { esc, fmtNum, fmtShape } from '../utils';

function countTreeParams(nd: GNode): number {
  if (nd.params !== undefined) return nd.params;
  let t = 0;
  for (const c of nd.children || []) t += countTreeParams(c);
  return t;
}

export class TreePanel {
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
    this.container.style.display = '';
    this.container.innerHTML = '<div class="panel-title">模块结构</div>';
    // 根节点路径置空：子级 qname 从根的直接子模块开始，与图内 group/target 路径对齐
    this.container.appendChild(this.item(root, '', true));
  }

  syncHighlight(nd: GNode | null): void {
    // 簇卡片用 clusterKey；模块调用用 target；普通算子无对应树节点
    const q = nd ? nd.clusterKey || (nd.kind === 'call_module' ? nd.target || nd.name : null) : null;
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
    const hasMod = kids.some(k => k.children !== undefined);
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
      kids.forEach(k => det.appendChild(this.item(k, qname)));
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
}
