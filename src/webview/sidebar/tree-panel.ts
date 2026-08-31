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
    private locate: (qname: string) => void
  ) {}

  render(data: GraphData): void {
    const root = data.tree;
    if (!root || data.kind === 'tree') {
      this.container.style.display = 'none';
      return;
    }
    this.container.style.display = '';
    this.container.innerHTML = '<div class="panel-title">模块结构</div>';
    this.container.appendChild(this.item(root, ''));
  }

  syncHighlight(nd: GNode | null): void {
    const q = nd && nd.kind === 'call_module' ? nd.target || nd.name : null;
    this.container.querySelectorAll('[data-qname]').forEach(e => {
      e.classList.toggle('hl', q !== null && (e as HTMLElement).dataset.qname === q);
    });
  }

  private item(nd: GNode, prefix: string): HTMLElement {
    const qname = prefix ? `${prefix}.${nd.name}` : nd.name || '';
    const div = document.createElement('div');
    div.className = 'tree-item';
    const kids = nd.children || [];
    const hasMod = kids.some(k => k.children !== undefined);
    if (hasMod) {
      const det = document.createElement('details');
      det.open = (prefix.match(/\./g) || []).length < 2;
      const sum = document.createElement('summary');
      sum.dataset.qname = qname;
      sum.innerHTML = `<span class="t-name">${esc(nd.name || '')}</span><span class="t-sub">${esc(nd.cls || '')} · ${fmtNum(nd.params ?? countTreeParams(nd))}</span>`;
      sum.addEventListener('click', () => this.locate(qname));
      det.appendChild(sum);
      kids.forEach(k => det.appendChild(this.item(k, qname)));
      div.appendChild(det);
    } else {
      const row = document.createElement('div');
      row.className = 'tree-leaf';
      row.dataset.qname = qname;
      const info = nd.shape ? ' ' + fmtShape(nd.shape) : '';
      row.innerHTML = `<span class="t-name">${esc(nd.name || '')}</span><span class="t-sub">${esc(nd.cls || '')}${esc(info)}</span>`;
      row.addEventListener('click', () => this.locate(qname));
      div.appendChild(row);
    }
    return div;
  }
}
