// DetailsPanel：右侧节点详情（元信息 / 选中节点属性 / 模块 attrs）
import type { GNode, GraphData } from '../types';
import { esc, fmtNum, fmtShape } from '../utils';
import { nodeColor } from '../categories';

export class DetailsPanel {
  constructor(private container: HTMLElement) {}

  show(nd: GNode | null, data: GraphData | null): void {
    if (!nd) {
      this.showMeta(data);
      return;
    }
    const shp = nd.out_shape ?? nd.shape;
    const rows: string[] = [];
    const row = (k: string, v: string) => rows.push(`<tr><th>${k}</th><td>${esc(v)}</td></tr>`);
    row('名称', nd.name || '-');
    row('类别', nd.cls || nd.kind || '-');
    if (nd.kind === 'call_module') row('模块路径', nd.target || nd.name);
    if (nd.group) row('所属模块', nd.group + (nd.group_cls ? `（${nd.group_cls}）` : ''));
    if (nd.summary) row('内容', nd.summary);
    if (shp && shp.length) row('输出形状', fmtShape(shp));
    if (nd.dtype) row('数据类型', nd.dtype.replace('torch.', ''));
    if (nd.params !== undefined) row('参数量', `${fmtNum(nd.params)} (${nd.params.toLocaleString()})`);
    let attrs = '';
    if (nd.attrs) {
      for (const [k, v] of Object.entries(nd.attrs)) {
        attrs += `<tr><th>${esc(k)}</th><td>${esc(typeof v === 'string' ? v : JSON.stringify(v))}</td></tr>`;
      }
    }
    this.container.innerHTML = `<h3><span class="dot" style="background:${nodeColor(nd)}"></span>${esc(nd.cls || nd.kind || '节点')}</h3>
<table class="kv">${rows.join('')}</table>
${attrs ? `<h4>属性</h4><table class="kv">${attrs}</table>` : ''}`;
  }

  private showMeta(data: GraphData | null): void {
    let html = '';
    if (data?.warning) html += `<div class="warn">${esc(data.warning)}</div>`;
    if (data?.total_params !== undefined)
      html += `<div class="meta">总参数量：<b>${fmtNum(data.total_params)}</b>（${data.total_params.toLocaleString()}）</div>`;
    if (data?.inputs?.length)
      html += `<div class="meta">输入：${data.inputs.map(i => `${esc(i.name || 'x')} ${esc(fmtShape(i.shape))}`).join('；')}</div>`;
    if (data?.outputs?.length)
      html += `<div class="meta">输出：${data.outputs.map(i => `${esc(i.name || 'y')}${i.shape ? ' ' + esc(fmtShape(i.shape)) : ''}`).join('；')}</div>`;
    html += `<div class="hint">滚轮缩放 · 拖拽平移 · 点击节点查看详情</div>`;
    this.container.innerHTML = html;
  }
}
