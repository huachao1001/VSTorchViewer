// 图例：自动列出当前视图中出现的算子类别
import type { GNode } from '../types';
import { esc } from '../utils';
import { CATS, nodeColor } from '../categories';
import { isIO } from '../node-metrics';
import { t } from '../i18n';

export function renderLegend(nodes: GNode[], area: HTMLElement): void {
  // 图例按会话（area）隔离：每个 tab 会话有自己的图例，不能跨会话用 document.getElementById 共享
  let leg = area.querySelector('#legend') as HTMLElement | null;
  if (!leg) {
    leg = document.createElement('div');
    leg.id = 'legend';
    area.appendChild(leg);
  }
  const used = new Map<string, string>();
  if (nodes.some(nd => isIO(nd))) used.set(t('Input/Output', '输入/输出'), '#43a047');
  for (const nd of nodes) {
    if (nd.virtual || isIO(nd)) continue;
    const c = nodeColor(nd);
    const cat = CATS.find(ct => ct.color === c);
    if (cat) used.set(cat.label, cat.color);
  }
  leg.innerHTML = [...used].map(([l, c]) => `<span class="lg-item"><i style="background:${c}"></i>${esc(l)}</span>`).join('');
}
