// DetailsPanel：右侧节点详情（元信息 / 选中节点属性 / 模块 attrs）+ 底部固定模型摘要
// 需传参模型导出后，参数表单常驻面板最底部：可重新编辑并再次导出
import type { GNode, GraphData } from '../types';
import { esc, fmtNum, fmtShape } from '../utils';
import { nodeColor } from '../categories';
import { t } from '../i18n';

export interface DetailsHooks {
  applyShape?: (shape: string) => void;
  getArgs?: (model: string) => Record<string, string> | undefined;
  submitArgs?: (model: string, args: Record<string, string>) => void;
}

export class DetailsPanel {
  // body 随选中内容滚动；footer 固定在面板底部：输入形状行 + 模型摘要（不随选中变化）；
  // argsEl 最底部：构造参数表单（仅需传参模型显示）
  private body: HTMLElement;
  private footer: HTMLElement;
  private summaryEl: HTMLElement;
  private shapeInput: HTMLInputElement;
  private argsEl: HTMLElement;
  // 当前参数表单归属：模型 + 数据键（模型不变仅保留编辑态；重导出后按键刷新回填）
  private argsModel: string | null = null;
  private argsKey = '';

  constructor(private container: HTMLElement, private hooks?: DetailsHooks) {
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
    this.shapeInput.placeholder = t('Input shape, e.g. 1,3,224,224;1,10', '输入形状，如 1,3,224,224;1,10');
    this.shapeInput.spellcheck = false;
    const apply = () => {
      const v = this.shapeInput.value.trim();
      if (v) this.hooks?.applyShape?.(v);
    };
    const btn = document.createElement('button');
    btn.className = 'shape-apply';
    btn.textContent = t('Apply', '应用');
    btn.addEventListener('click', apply);
    this.shapeInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') apply();
    });
    shapeRow.append(this.shapeInput, btn);
    this.summaryEl = document.createElement('div');
    this.footer.append(shapeRow, this.summaryEl);
    this.argsEl = document.createElement('div');
    this.argsEl.id = 'details-args';
    container.append(this.body, this.footer, this.argsEl);
  }

  // 会话切换后本实例的 DOM 可能被其他会话顶掉：重新挂载（输入形状等状态保留在元素上）
  private ensureMounted(): void {
    if (!this.body.isConnected) {
      this.container.innerHTML = '';
      this.container.append(this.body, this.footer, this.argsEl);
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
    this.rebuildArgs(data);
    this.showSummary(data);
    if (!nd) {
      this.showMeta(data);
      return;
    }
    const shp = nd.out_shape ?? nd.shape;
    const rows: string[] = [];
    const row = (k: string, v: string) => rows.push(`<tr><th>${k}</th><td>${esc(v)}</td></tr>`);
    row(t('Name', '名称'), nd.name || '-');
    row(t('Kind', '类别'), nd.cls || nd.kind || '-');
    if (nd.kind === 'call_module') row(t('Module Path', '模块路径'), nd.target || nd.name);
    if (nd.group) row(t('Parent Module', '所属模块'), nd.group + (nd.group_cls ? t(` (${nd.group_cls})`, `（${nd.group_cls}）`) : ''));
    if (nd.summary) row(t('Contents', '内容'), nd.summary);
    if (shp && shp.length) row(t('Output Shape', '输出形状'), fmtShape(shp));
    if (nd.dtype) row(t('Data Type', '数据类型'), nd.dtype.replace('torch.', ''));
    if (nd.params !== undefined) row(t('Params', '参数量'), `${fmtNum(nd.params)} (${nd.params.toLocaleString()})`);
    if (nd.macs) row('MACs', `${fmtNum(nd.macs)} (${nd.macs.toLocaleString()})`);
    let attrs = '';
    if (nd.attrs) {
      for (const [k, v] of Object.entries(nd.attrs)) {
        attrs += `<tr><th>${esc(k)}</th><td>${esc(typeof v === 'string' ? v : JSON.stringify(v))}</td></tr>`;
      }
    }
    this.body.innerHTML = `<h3><span class="dot" style="background:${nodeColor(nd)}"></span>${esc(nd.cls || nd.kind || t('Node', '节点'))}</h3>
<table class="kv">${rows.join('')}</table>
${attrs ? `<h4>${t('Attributes', '属性')}</h4><table class="kv">${attrs}</table>` : ''}`;
  }

  // 已被用户关闭的警告（按 data 对象记忆；重新导出产生新 data → 警告重新出现）
  private dismissed = new WeakSet<GraphData>();

  private showMeta(data: GraphData | null): void {
    this.rebuildArgs(data);
    let html = '';
    if (data?.warning && !this.dismissed.has(data)) {
      html += `<div class="warn"><button class="warn-close" title="${t('Close', '关闭')}">×</button><span>${esc(data.warning)}</span></div>`;
    }
    html += `<div class="hint">${t('Scroll to zoom · Drag to pan · Click a node for details', '滚轮缩放 · 拖拽平移 · 点击节点查看详情')}</div>`;
    this.body.innerHTML = html;
    this.body.querySelector('.warn-close')?.addEventListener('click', () => {
      if (data) this.dismissed.add(data);
      this.body.querySelector('.warn')?.remove();
    });
  }

  // 底部固定摘要：输入/输出形状、参数量、MACs、FLOPs
  private showSummary(data: GraphData | null): void {
    if (!data || (data.total_params === undefined && !data.total_macs && !data.inputs?.length && !data.outputs?.length)) {
      this.summaryEl.innerHTML = `<div class="s-hint">${t('Enter an input shape to compute node shapes and MACs/FLOPs', '输入形状后计算各节点形状与 MACs/FLOPs')}</div>`;
      return;
    }
    const row = (k: string, v: string) => `<div class="s-row"><span class="s-k">${k}</span><span class="s-v">${v}</span></div>`;
    const num = (n: number) => `${fmtNum(n)} <i>(${n.toLocaleString()})</i>`;
    let html = '';
    if (data.inputs?.length)
      html += row(t('Inputs', '输入'), data.inputs.map(i => `${esc(i.name || 'x')} ${esc(fmtShape(i.shape))}`).join('<br>'));
    if (data.outputs?.length)
      html += row(t('Outputs', '输出'), data.outputs.map(i => `${esc(i.name || 'y')}${i.shape ? ' ' + esc(fmtShape(i.shape)) : ''}`).join('<br>'));
    if (data.total_params !== undefined) html += row(t('Params', '参数量'), num(data.total_params));
    if (data.total_macs) html += row('MACs', num(data.total_macs));
    if (data.total_flops) html += row('FLOPs', num(data.total_flops));
    this.summaryEl.innerHTML = html;
  }

  // 构造参数表单（右下角常驻）：仅需传参的模型显示；模型不变不重建（保留编辑中内容），
  // 重导出后数据键变化 → 用已提交参数回填刷新
  private rebuildArgs(data: GraphData | null): void {
    const model = String(data?.model || '');
    const cls = data?.classes?.find(c => c.name === model);
    const params = cls && !cls.instantiable ? cls.params || [] : [];
    const key = model + '|' + String((data as { __tvKey?: string } | null)?.__tvKey || '');
    if (!model || !params.length) {
      if (this.argsModel !== null || this.argsEl.childNodes.length) {
        this.argsModel = null;
        this.argsKey = '';
        this.argsEl.innerHTML = '';
      }
      return;
    }
    if (this.argsModel === model && this.argsKey === key) return;
    this.argsModel = model;
    this.argsKey = key;
    const submitted = this.hooks?.getArgs?.(model) || {};
    this.argsEl.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'args-title';
    title.textContent = t('Constructor args · edit and re-export', '构造参数 · 可修改后重新导出');
    const form = document.createElement('div');
    form.className = 'tv-form';
    const inputs = new Map<string, HTMLInputElement>();
    for (const p of params) {
      const row = document.createElement('div');
      row.className = 'f-row';
      const label = document.createElement('span');
      label.className = 'f-label';
      label.textContent = p.name + (p.annotation ? ` : ${p.annotation}` : '');
      label.title = p.required ? t('required', '必填') : t('optional', '可选');
      const input = document.createElement('input');
      input.className = 'f-input';
      input.spellcheck = false;
      input.value = submitted[p.name] ?? p.default ?? '';
      input.placeholder = p.required ? t('Required, Python literal', '必填，Python 字面量') : t('Leave empty for default', '留空用默认值');
      inputs.set(p.name, input);
      row.append(label, input);
      form.appendChild(row);
    }
    const actions = document.createElement('div');
    actions.className = 'f-actions';
    const btn = document.createElement('button');
    btn.className = 'f-apply';
    btn.textContent = t('Re-export', '重新导出');
    btn.addEventListener('click', () => {
      const out: Record<string, string> = {};
      let bad = false;
      for (const [name, input] of inputs) {
        input.classList.remove('missing');
        const v = input.value.trim();
        if (!v && params.find(x => x.name === name)!.required) {
          input.classList.add('missing');
          bad = true;
          continue;
        }
        if (v) out[name] = v;
      }
      if (bad) return;
      btn.disabled = true;
      btn.textContent = t('Exporting…', '导出中…');
      this.hooks?.submitArgs?.(model, out);
    });
    actions.appendChild(btn);
    form.appendChild(actions);
    this.argsEl.append(title, form);
  }
}
