// PanelRenderer：嵌套组合背景（盒子与标签分离绘制，避免嵌套互遮）
import type { Panel } from '../types';
import { el, fmtNum, FONT_PANEL, FONT_PANEL_SUB, truncate } from '../utils';

export class PanelRenderer {
  render(panels: Panel[], container: SVGGElement): void {
    container.innerHTML = '';
    // 盒子：外层（面积大）先画；标签：全部画在盒子之上，内层标签最后画
    for (const p of panels) container.appendChild(this.box(p));
    for (const p of panels) container.appendChild(this.label(p));
  }

  private box(p: Panel): SVGElement {
    return el('rect', {
      x: p.x!.toFixed(1),
      y: p.yTop!.toFixed(1),
      width: p.w!.toFixed(1),
      height: p.yH!.toFixed(1),
      rx: 10,
      class: 'panel-box',
    });
  }

  private label(p: Panel): SVGGElement {
    const g = el('g', { class: 'panel' }) as unknown as SVGGElement;
    const t1 = el('text', { x: (p.x! + 4).toFixed(1), y: (p.yTop! + 17).toFixed(1), class: 'panel-name' });
    t1.style.font = FONT_PANEL;
    t1.textContent = p.label;
    g.appendChild(t1);
    const sub = p.clss.slice(0, 2).join(' · ') + (p.params ? `  ·  ${fmtNum(p.params)}` : '');
    if (sub) {
      const t2 = el('text', { x: (p.x! + 4).toFixed(1), y: (p.yTop! + 30).toFixed(1), class: 'panel-sub' });
      t2.style.font = FONT_PANEL_SUB;
      t2.textContent = truncate(sub, FONT_PANEL_SUB, p.w! - 20);
      g.appendChild(t2);
    }
    return g;
  }
}
