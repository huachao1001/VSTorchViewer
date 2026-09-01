// TreePanel：左侧模块结构树（渲染全局模块树 MNode——与拓扑图同一结构源，支持关键字筛选）
import type { GNode, MNode } from '../types';
import { esc, fmtNum, fmtShape } from '../utils';
import { t } from '../i18n';

export class TreePanel {
  private root: MNode | null = null;
  // 筛选关键字（小写）；空 = 不筛选
  private filter = '';
  private input: HTMLInputElement;
  private content: HTMLElement;

  constructor(
    private container: HTMLElement,
    private locate: (qname: string, isModule: boolean) => void
  ) {
    // 每个会话有自己的面板实例但共享同一容器：挂载前清空，避免多会话 DOM 叠加
    container.innerHTML = '';
    // 筛选输入框与树内容区一次性创建：重渲染只刷新内容区，输入框焦点与文本得以保留
    const input = document.createElement('input');
    this.input = input;
    input.className = 'tree-search';
    input.placeholder = t('Filter nodes...', '搜索筛选节点...');
    input.spellcheck = false;
    input.addEventListener('input', () => {
      this.filter = input.value.trim().toLowerCase();
      this.renderTree();
    });
    this.content = document.createElement('div');
    container.append(input, this.content);
  }

  // 会话切换后本实例的 DOM 可能被其他会话顶掉：重新挂载（搜索关键字保留在输入框上）
  private ensureMounted(): void {
    if (!this.content.isConnected) {
      this.container.innerHTML = '';
      this.container.append(this.input, this.content);
    }
  }

  // 会话无数据（如参数表单态 / 模块树回退视图）：隐藏树面板
  clear(): void {
    this.ensureMounted();
    this.container.style.display = 'none';
  }

  render(root: MNode | null): void {
    this.ensureMounted();
    this.root = root;
    if (!root) {
      this.container.style.display = 'none';
      return;
    }
    this.container.style.display = '';
    this.renderTree();
  }

  // 按当前关键字重建树；命中的祖先链自动展开
  private renderTree(): void {
    this.content.innerHTML = `<div class="panel-title">${t('Module Structure', '模块结构')}</div>`;
    if (!this.root) return;
    const el = this.item(this.root, true);
    if (el) this.content.appendChild(el);
    if (this.filter && !this.content.querySelector('.tree-item, .tree-leaf')) {
      const empty = document.createElement('div');
      empty.className = 'tree-empty';
      empty.textContent = t('No matching nodes', '无匹配节点');
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

  // 筛选保留判定：自身命中（key/名称/类名）或后代（子模块/参数/算子）命中
  private kept(m: MNode): boolean {
    if (!this.filter) return true;
    if (`${m.key} ${m.name} ${m.cls || ''}`.toLowerCase().includes(this.filter)) return true;
    if (m.others.some(k => this.kept(k))) return true;
    if (m.ops.some(o => this.opKept(o))) return true;
    return m.children.some(c => this.kept(c));
  }

  private opKept(o: MNode): boolean {
    // 匹配范围：所属模块路径 + fx 节点名 + 算子名
    const nd = o.node!;
    return `${o.key} ${nd.name} ${nd.cls || ''}`.toLowerCase().includes(this.filter);
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

  // 树内展示的算子：自由算子（call_function/call_method），与旧版树面板一致
  private static visibleOp(o: MNode): boolean {
    const k = o.node?.kind;
    return k === 'call_function' || k === 'call_method';
  }

  private item(m: MNode, isRoot = false): HTMLElement | null {
    if (this.filter && !this.kept(m)) return null;
    const div = document.createElement('div');
    div.className = 'tree-item';
    const ops = m.ops.filter(o => TreePanel.visibleOp(o) && (!this.filter || this.opKept(o)));
    const hasMod = m.children.length > 0 || ops.length > 0;
    if (hasMod) {
      const det = document.createElement('details');
      det.open = this.filter ? true : (m.key.match(/\./g) || []).length < 2;
      const sum = document.createElement('summary');
      sum.dataset.qname = m.key;
      // 独立三角形：点击仅展开/折叠树节点（details 默认行为），不触发定位
      const caret = document.createElement('span');
      caret.className = 't-caret';
      const name = document.createElement('span');
      name.className = 't-name';
      name.innerHTML = this.hi(m.name);
      const sub = document.createElement('span');
      sub.className = 't-sub';
      sub.innerHTML = `${this.hi(m.cls || '')} · ${fmtNum(m.params ?? 0)}`;
      sum.append(caret, name, sub);
      sum.addEventListener('click', e => {
        if ((e.target as Element).classList.contains('t-caret')) return;
        e.preventDefault(); // 行点击：仅定位选中，不切换折叠
        this.locate(m.key, true);
      });
      det.appendChild(sum);
      // 参数/缓冲保持在前；子模块与算子按图执行序（数据流）交错排列
      m.others.forEach(k => {
        const el = this.item(k);
        if (el) det.appendChild(el);
      });
      const entries = [
        ...m.children.map(c => ({ mod: c as MNode | null, op: null as MNode | null, i: c.flowIdx })),
        ...ops.map(o => ({ mod: null as MNode | null, op: o as MNode | null, i: o.flowIdx })),
      ];
      entries.sort((a, b) => a.i - b.i);
      for (const e of entries) {
        if (e.op) det.appendChild(this.opRow(e.op));
        else {
          const el = this.item(e.mod!);
          if (el) det.appendChild(el);
        }
      }
      div.appendChild(det);
    } else {
      const row = document.createElement('div');
      row.className = 'tree-leaf';
      row.dataset.qname = m.key;
      const info = m.shape ? ' ' + fmtShape(m.shape) : '';
      row.innerHTML = `<span class="t-name">${this.hi(m.name)}</span><span class="t-sub">${this.hi(m.cls || '')}${esc(info)}</span>`;
      row.addEventListener('click', () => this.locate(m.key, false));
      div.appendChild(row);
    }
    return div;
  }

  // 自由算子叶子：点击定位到全细节层的对应节点
  private opRow(o: MNode): HTMLElement {
    const nd = o.node!;
    const row = document.createElement('div');
    row.className = 'tree-leaf';
    row.dataset.qname = nd.name;
    const info = nd.out_shape ? ' ' + fmtShape(nd.out_shape) : '';
    row.innerHTML = `<span class="t-name">${this.hi(nd.cls || nd.name || '')}</span><span class="t-sub">${esc(info)}</span>`;
    row.addEventListener('click', () => this.locate(nd.name, false));
    return row;
  }
}
