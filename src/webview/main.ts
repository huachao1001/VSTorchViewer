// TorchViewer webview 入口：装配模型 / 视图 / 侧边栏，处理与扩展主进程的消息
// 架构：
//   GraphModel   —— 数据模型（层级折叠、dagre 布局、背景盒后处理、选中解析）
//   GraphView    —— 视图控制器（渲染循环、缩放平移、交互、选中高亮、搜索）
//   render/*     —— SVG 构建器（节点 / 连线 / 组合背景 / 图例）
//   sidebar/*    —— 详情面板 / 模块树
import { GraphModel } from './graph-model';
import { GraphView } from './view/graph-view';
import type { GraphData } from './types';
import { esc } from './utils';

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): Record<string, unknown> | undefined;
  setState(state: Record<string, unknown>): void;
};
const vscode = acquireVsCodeApi();

const svg = document.getElementById('svg') as unknown as SVGSVGElement;
const viewport = document.getElementById('viewport') as unknown as SVGGElement;
const panelsG = document.getElementById('panels') as unknown as SVGGElement;
const edgesG = document.getElementById('edges') as unknown as SVGGElement;
const nodesG = document.getElementById('nodes') as unknown as SVGGElement;

const model = new GraphModel();
const view = new GraphView(model, {
  svg,
  viewport,
  panelsG,
  edgesG,
  nodesG,
  graphArea: document.getElementById('graph-area')!,
  details: document.getElementById('details')!,
  tree: document.getElementById('tree-panel')!,
}, {
  // 输入形状在预览界面内提交，重导出后由扩展推送新数据
  applyShape: shape => vscode.postMessage({ type: 'input', shape }),
});
view.init();

// 顶部 tab：同文件多个 nn.Module 之间切换（请求扩展重导出对应类）
const tabs = document.getElementById('model-tabs')!;
type ClsInfo = NonNullable<GraphData['classes']>[number];
function renderTabs(classes: ClsInfo[] | undefined, current?: string): void {
  const list = classes || [];
  if (!list.length) {
    tabs.style.display = 'none';
    return;
  }
  tabs.style.display = '';
  tabs.innerHTML = '';
  for (const c of list) {
    const b = document.createElement('button');
    b.className = 'tab' + (c.name === current ? ' active' : '');
    b.textContent = c.name;
    if (!c.instantiable) b.title = '需要构造参数';
    b.addEventListener('click', () => vscode.postMessage({ type: 'export', model: c.name }));
    tabs.appendChild(b);
  }
}

// 树面板与图形区之间的拖拽分隔条：左右拉伸动态调整两侧宽度
// 宽度记忆：基于 webview 持久化状态（getState/setState），刷新/重开面板自动恢复
const splitter = document.getElementById('tree-splitter');
if (splitter) {
  const treePanel = document.getElementById('tree-panel')!;
  const main = document.getElementById('main')!;
  const setTreeWidth = (w: number) => {
    treePanel.style.width = `${Math.min(600, Math.max(150, w))}px`;
  };
  const saved = vscode.getState()?.treeWidth;
  if (typeof saved === 'number') setTreeWidth(saved);
  let dragging = false;
  splitter.addEventListener('pointerdown', e => {
    dragging = true;
    splitter.setPointerCapture(e.pointerId);
    splitter.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  splitter.addEventListener('pointermove', e => {
    if (!dragging) return;
    setTreeWidth(e.clientX - main.getBoundingClientRect().left);
  });
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    vscode.setState({ ...vscode.getState(), treeWidth: treePanel.offsetWidth });
  };
  splitter.addEventListener('pointerup', stop);
  splitter.addEventListener('pointercancel', stop);
}

// 调试/测试钩子
(window as unknown as { __tv?: unknown }).__tv = { model, view };

// 加载遮罩：解析期间显示进度（转圈 + 文字），失败显示错误（点击关闭）
// 日志不在这里展示：统一走 VS Code 输出面板（TorchViewer）
// 扩展 HTML 里自带该节点；浏览器调试预览没有则动态创建
let loadingEl: HTMLElement | undefined;
// 表单模式：表单一旦显示就常驻，直到导出成功（data）才隐藏；出错/进度都不替换表单
let formActive = false;
function coreHtml(): string {
  return '<div class="spinner"></div><div class="tv-loading-text"></div>';
}
function ensureCore(el: HTMLElement): void {
  // 核心结构缺失（如表单渲染覆盖过）→ 重建
  if (!el.querySelector('.spinner')) el.insertAdjacentHTML('beforeend', coreHtml());
}
function ensureLoading(): HTMLElement {
  if (loadingEl) return loadingEl;
  let el = document.getElementById('tv-loading');
  if (!el) {
    el = document.createElement('div');
    el.id = 'tv-loading';
    el.innerHTML = coreHtml();
    // 遮罩只盖图形区（tab / 树 / 详情保持可见可点）
    (document.getElementById('graph-area') || document.body).appendChild(el);
  }
  ensureCore(el);
  el.addEventListener('click', () => {
    if (el!.classList.contains('error')) el!.style.display = 'none';
  });
  loadingEl = el;
  return el;
}
function showProgress(text: string): void {
  const el = ensureLoading();
  el.classList.remove('error', 'form');
  ensureCore(el);
  el.style.display = 'flex';
  const t = el.querySelector('.tv-loading-text') as HTMLElement;
  if (t) t.textContent = text;
}
function hideProgress(): void {
  if (loadingEl) loadingEl.style.display = 'none';
}
function showLoadError(message: string): void {
  const el = ensureLoading();
  formActive = false;
  el.classList.remove('form');
  el.classList.add('error');
  ensureCore(el);
  el.style.display = 'flex';
  const t = el.querySelector('.tv-loading-text') as HTMLElement;
  if (t) t.textContent = `${message}（点击关闭）`;
}
// 表单填写期间出错（如导出失败）：错误提示显示在表单内，表单保留供修改重填，不关闭
function showFormError(message: string): void {
  const el = ensureLoading();
  const hint = el.querySelector('.f-error') as HTMLElement | null;
  if (hint) hint.textContent = message;
  const btn = el.querySelector('.f-apply') as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = false;
    btn.textContent = '导出';
  }
  el.style.display = 'flex';
}
// 构造参数表单：需要传参的 nn.Module 逐参数输入（Python 字面量，默认值预填）
function renderForm(model: string, classes: ClsInfo[]): void {
  const el = ensureLoading();
  el.classList.remove('error');
  el.classList.add('form');
  el.style.display = 'flex';
  const cls = classes.find(c => c.name === model);
  const params = cls?.params || [];
  el.innerHTML = `<div class="tv-loading-text"><b>${esc(model)}</b> 构造参数</div><div class="tv-form"></div>`;
  const form = el.querySelector('.tv-form') as HTMLElement;
  const inputs = new Map<string, HTMLInputElement>();
  // 签名解析失败（params 为空）时退化为单个自由输入框：用户直接填完整构造参数
  let rawInput: HTMLInputElement | undefined;
  if (!params.length) {
    const row = document.createElement('div');
    row.className = 'f-row';
    const label = document.createElement('span');
    label.className = 'f-label';
    label.textContent = '构造参数';
    rawInput = document.createElement('input');
    rawInput.className = 'f-input';
    rawInput.spellcheck = false;
    rawInput.placeholder = '如 32 或 channels=32, kernel_size=3';
    row.append(label, rawInput);
    form.appendChild(row);
  }
  for (const p of params) {
    const row = document.createElement('div');
    row.className = 'f-row';
    const label = document.createElement('span');
    label.className = 'f-label';
    label.textContent = p.name + (p.annotation ? ` : ${p.annotation}` : '');
    label.title = p.required ? '必填' : '可选';
    const input = document.createElement('input');
    input.className = 'f-input';
    input.spellcheck = false;
    input.value = p.default ?? '';
    input.placeholder = p.required ? '必填，Python 字面量' : '留空用默认值';
    inputs.set(p.name, input);
    row.append(label, input);
    form.appendChild(row);
  }
  const applyRow = document.createElement('div');
  applyRow.className = 'f-actions';
  const btn = document.createElement('button');
  btn.className = 'f-apply';
  btn.textContent = '导出';
  const hint = document.createElement('div');
  hint.className = 'f-hint';
  hint.textContent = '值为 Python 字面量：数字直接写，字符串带引号（如 \'imagenet\'），列表如 [3, 4]';
  const err = document.createElement('div');
  err.className = 'f-error';
  applyRow.append(btn);
  form.append(applyRow, hint, err);
  formActive = true;
  const submit = () => {
    if (rawInput) {
      rawInput.classList.remove('missing');
      const v = rawInput.value.trim();
      if (!v) {
        rawInput.classList.add('missing');
        return;
      }
      err.textContent = '';
      btn.disabled = true;
      btn.textContent = '导出中…';
      vscode.postMessage({ type: 'export', model, raw: v });
      return;
    }
    const args: Record<string, string> = {};
    let bad = false;
    for (const [name, input] of inputs) {
      input.classList.remove('missing');
      const v = input.value.trim();
      const p = params.find(x => x.name === name)!;
      if (!v && p.required) {
        input.classList.add('missing');
        bad = true;
        continue;
      }
      if (v) args[name] = v;
    }
    if (bad) return;
    err.textContent = '';
    btn.disabled = true;
    btn.textContent = '导出中…';
    vscode.postMessage({ type: 'export', model, args });
  };
  btn.addEventListener('click', submit);
  form.addEventListener('keydown', e => {
    if (e.key === 'Enter') submit();
  });
  const first = rawInput || (inputs.values().next().value as HTMLInputElement | undefined);
  first?.focus();
}

// 看门狗：长时间收不到扩展侧任何消息（data/progress/error/form）→ 给出可操作的提示，避免无限转圈
let gotMessage = false;
const watchdog = setTimeout(() => {
  if (!gotMessage) showLoadError('扩展侧长时间无响应：请查看输出面板（TorchViewer）排查，或重新运行命令');
}, 20000);

window.addEventListener('message', e => {
  const m = e.data;
  if (!gotMessage) {
    gotMessage = true;
    clearTimeout(watchdog);
  }
  const m2 = m;
  if (m2.type === 'data' && m2.data) {
    formActive = false;
    hideProgress();
    view.onData(m2.data as GraphData);
    renderTabs(m2.data.classes, m2.data.model);
  } else if (m2.type === 'progress') {
    // 表单填写期间忽略进度消息，保持表单原样（表单提交后按钮已是"导出中…"）
    if (!formActive) showProgress(String(m2.text || '正在解析…'));
  } else if (m2.type === 'error') {
    if (formActive) showFormError(String(m2.message || '解析失败'));
    else showLoadError(String(m2.message || '解析失败'));
  } else if (m2.type === 'tabs') {
    renderTabs(m2.classes, m2.model);
  } else if (m2.type === 'form' && m2.model) {
    renderTabs(m2.classes, m2.model);
    renderForm(String(m2.model), m2.classes || []);
  }
});

vscode.postMessage({ type: 'ready' });
