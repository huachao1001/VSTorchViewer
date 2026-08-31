// NodeRenderer：节点 SVG 构建（普通卡片 / 聚合卡片 / IO 药丸）
import type { GNode } from '../types';
import { el, fmtNum, FONT_NAME, FONT_SHAPE, FONT_SUMMARY, FONT_TYPE, textW, truncate } from '../utils';
import { nodeColor } from '../categories';
import { isIO, shapeStr } from '../node-metrics';

export class NodeRenderer {
  build(nd: GNode): SVGGElement {
    const color = nodeColor(nd);
    const g = el('g', { class: 'node' }) as unknown as SVGGElement;
    g.style.transform = `translate(${nd.x!.toFixed(1)}px, ${nd.y!.toFixed(1)}px)`;
    g.dataset.id = String(nd.id);

    // 原生 tooltip
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = [nd.name, nd.cls, nd.summary, nd.target, shapeStr(nd)].filter(Boolean).join('\n');
    g.appendChild(title);

    if (isIO(nd)) return this.buildIO(g, nd, color);
    this.buildCard(g, nd, color);
    return g;
  }

  // 输入/输出：药丸形 + 内嵌虚线框（引文双线效果），名称加「」引用号
  private buildIO(g: SVGGElement, nd: GNode, color: string): SVGGElement {
    const head = nd.kind === 'placeholder' ? '输入 · ' : '输出 · ';
    g.appendChild(
      el('rect', {
        width: nd.w!.toFixed(1),
        height: nd.h!.toFixed(1),
        rx: nd.h! / 2,
        fill: color,
        'fill-opacity': 0.13,
        stroke: color,
        'stroke-opacity': 0.55,
        class: 'io-pill',
      })
    );
    g.appendChild(
      el('rect', {
        x: 3,
        y: 3,
        width: (nd.w! - 6).toFixed(1),
        height: (nd.h! - 6).toFixed(1),
        rx: (nd.h! - 6) / 2,
        fill: 'none',
        stroke: color,
        'stroke-opacity': 0.4,
        'stroke-dasharray': '3 3',
        class: 'io-inner',
      })
    );
    const shp = shapeStr(nd);
    const cy = shp ? 16 : nd.h! / 2 + 4;
    const maxName = nd.w! - 20 - textW(head, FONT_NAME) - textW('「」', FONT_NAME);
    const t = el('text', { x: (nd.w! / 2).toFixed(1), y: cy.toFixed(1), 'text-anchor': 'middle', class: 'io-text' });
    t.style.font = FONT_NAME;
    t.setAttribute('fill', color);
    t.textContent = head + '「' + truncate(nd.name || '', FONT_NAME, maxName) + '」';
    g.appendChild(t);
    if (shp) {
      const t2 = el('text', { x: (nd.w! / 2).toFixed(1), y: 30, 'text-anchor': 'middle', class: 'io-text' });
      t2.style.font = FONT_SHAPE;
      t2.setAttribute('fill', color);
      t2.setAttribute('fill-opacity', String(0.8));
      t2.textContent = shp;
      g.appendChild(t2);
    }
    return g;
  }

  // 普通节点：Netron 风格——彩色标题条（白字）+ 浅色主体；聚合卡片标题用模块路径
  private buildCard(g: SVGGElement, nd: GNode, color: string): void {
    g.appendChild(el('rect', { width: nd.w!.toFixed(1), height: nd.h!.toFixed(1), rx: 6, class: 'card' }));
    // 顶部圆角标题条
    const w = nd.w!.toFixed(1);
    g.appendChild(
      el('path', {
        d: `M 0 26 L 0 6 Q 0 0 6 0 L ${nd.w! - 6} 0 Q ${w} 0 ${w} 6 L ${w} 26 Z`,
        fill: color,
        class: 'accent',
      })
    );

    // 聚合卡片只显示模块路径最后一级（完整路径在 tooltip 里）
    const head = nd.kind === 'module-cluster' ? (nd.name || '').split('.').pop() || nd.cls || '' : nd.cls || nd.kind || '';
    const headT = el('text', { x: 12, y: 17.5, class: 'n-name' });
    headT.style.font = FONT_NAME;
    const pw = nd.params !== undefined ? textW(fmtNum(nd.params), FONT_TYPE) + 12 : 0;
    headT.textContent = truncate(head, FONT_NAME, nd.w! - 20 - pw);
    g.appendChild(headT);
    if (nd.params !== undefined) {
      const p = el('text', { x: nd.w! - 9, y: 17.5, 'text-anchor': 'end', class: 'n-params' });
      p.style.font = FONT_TYPE;
      p.textContent = fmtNum(nd.params);
      g.appendChild(p);
    }

    let y = 40;
    const shp = shapeStr(nd);
    if (nd.summary) {
      const t = el('text', { x: 12, y: y, class: 'n-summary' });
      t.style.font = FONT_SUMMARY;
      t.textContent = truncate(nd.summary, FONT_SUMMARY, nd.w! - 20);
      g.appendChild(t);
      y += 15;
    }
    if (shp) {
      const t = el('text', { x: 12, y: y, class: 'n-shape' });
      t.style.font = FONT_SHAPE;
      t.textContent = truncate(shp, FONT_SHAPE, nd.w! - 20);
      g.appendChild(t);
    }
  }
}
