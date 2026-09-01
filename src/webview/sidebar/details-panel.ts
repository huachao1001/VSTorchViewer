// DetailsPanel：右侧节点详情（元信息 / 选中节点属性 / 模块 attrs）+ 底部固定模型摘要
import type { GNode, GraphData } from '../types';
import { esc, fmtNum, fmtShape } from '../utils';
import { nodeColor } from '../categories';

export class DetailsPanel {
  // body 随选中内容滚动；footer 固定在面板底部：输入形状行 + 模型摘要（不随选中变化）
  private body: HTMLElement;
  private footer: HTMLElement;
  private summaryEl: HTMLElement;
  private shapeInput: HTMLInputElement;

  constructor(private container: HTMLElement, applyShape?: (shape: string) => void) {
    // 每个会话有自己的面板实例但共享同一容器：挂载前清空，避免多会话 DOM 叠加
    container.innerHTML = '';
    this.body = document.createElement('div');
    this.body.className = 'details-body';
    this.footer = document.createElement('div');
    this.footer.id = 'details-summary';
    // 输入形状行：输入后重新导出以计算形状/参数量关联的 MACs、FLOPs
    const shapeRow = document.createElement('div');
    shapeRow.className = 'shape-row';
    this.shapeInput = document.createElement('input');
    this.shapeInput.className = 'shape-input';
    this.shapeInput.placeholder = '输入形状，如 1,3,224,224;1,10';
    this.shapeInput.spellcheck = false;
    const apply = () => {
      const v = this.shapeInput.value.trim();
      if (v) applyShape?.(v);
    };
    const btn = document.createElement('button');
    btn.className = 'shape-apply';
    btn.textContent = '应用';
    btn.addEventListener('click', apply);
    this.shapeInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') apply();
    });
    shapeRow.append(this.shapeInput, btn);
    this.summaryEl = document.createElement('div');
    this.footer.append(shapeRow, this.summaryEl);
    container.append(this.body, this.footer);
  }

  // 会话切换后本实例的 DOM 可能被其他会话顶掉：重新挂载（输入形状等状态保留在元素上）
  private ensureMounted(): void {
    if (!this.body.isConnected) {
      this.container.innerHTML = '';
      this.container.append(this.body, this.footer);
    }
  }

  // 会话无数据（如参数表单态）：右侧显示占位提示
  showPlaceholder(text: string): void {
    this.ensureMounted();
    this.body.innerHTML = `<div class="hint">${esc(text)}</div>`;
    this.summaryEl.innerHTML = '';
  }

  show(nd: GNode | null, data: GraphData | null): void {
    this.ensureMounted();
    this.showSummary(data);
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
    if (nd.macs) row('MACs', `${fmtNum(nd.macs)} (${nd.macs.toLocaleString()})`);
    let attrs = '';
    if (nd.attrs) {
      for (const [k, v] of Object.entries(nd.attrs)) {
        attrs += `<tr><th>${esc(k)}</th><td>${esc(typeof v === 'string' ? v : JSON.stringify(v))}</td></tr>`;
      }
    }
    this.body.innerHTML = `<h3><span class="dot" style="background:${nodeColor(nd)}"></span>${esc(nd.cls || nd.kind || '节点')}</h3>
<table class="kv">${rows.join('')}</table>
${attrs ? `<h4>属性</h4><table class="kv">${attrs}</table>` : ''}`;
  }

  private showMeta(data: GraphData | null): void {
    let html = '';
    if (data?.warning) html += `<div class="warn">${esc(data.warning)}</div>`;
    html += `<div class="hint">滚轮缩放 · 拖拽平移 · 点击节点查看详情</div>`;
    this.body.innerHTML = html;
  }

  // 底部固定摘要：输入/输出形状、参数量、MACs、FLOPs
  private showSummary(data: GraphData | null): void {
    if (!data || (data.total_params === undefined && !data.total_macs && !data.inputs?.length && !data.outputs?.length)) {
      this.summaryEl.innerHTML = '<div class="s-hint">输入形状后计算各节点形状与 MACs/FLOPs</div>';
      return;
    }
    const row = (k: string, v: string) => `<div class="s-row"><span class="s-k">${k}</span><span class="s-v">${v}</span></div>`;
    const num = (n: number) => `${fmtNum(n)} <i>(${n.toLocaleString()})</i>`;
    let html = '';
    if (data.inputs?.length)
      html += row('输入', data.inputs.map(i => `${esc(i.name || 'x')} ${esc(fmtShape(i.shape))}`).join('<br>'));
    if (data.outputs?.length)
      html += row('输出', data.outputs.map(i => `${esc(i.name || 'y')}${i.shape ? ' ' + esc(fmtShape(i.shape)) : ''}`).join('<br>'));
    if (data.total_params !== undefined) html += row('参数量', num(data.total_params));
    if (data.total_macs) html += row('MACs', num(data.total_macs));
    if (data.total_flops) html += row('FLOPs', num(data.total_flops));
    this.summaryEl.innerHTML = html;
  }
}
