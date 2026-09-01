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
import { t } from './i18n';

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): Record<string, unknown> | undefined;
  setState(state: Record<string, unknown>): void;
};
const vscode = acquireVsCodeApi();

const graphArea = document.getElementById('graph-area')!;
const detailsEl = document.getElementById('details')!;
const treeEl = document.getElementById('tree-panel')!;

// 每个 nn.Module tab 一个独立会话：自己的 svg / GraphModel / GraphView / 表单层
// 切换 tab 只切换会话容器可见性，已渲染 DOM 与缩放/平移/选中状态原样保留，不重建
interface Session {
  wrap: HTMLDivElement;
  view: GraphView;
  formLayer: HTMLDivElement; // 本会话的构造参数表单层（属于 tab content，随 tab 整体切换）
  lastKey?: string; // 最近一次渲染数据的缓存键（同一份数据重复推送时跳过重渲染）
}
const sessions = new Map<string, Session>();
let activeSession: Session | undefined;
// 已提交的构造参数（按模型记忆）：详情面板右下角的常驻参数表单用它回填，可重新编辑后再次导出；
// 重新弹表单时也作为默认值预填（尽量沿用上次填写）
const lastArgsByModel = new Map<string, Record<string, string>>();
// 最近一次请求导出的模型 + 最近收到的类清单：自动导出失败时用于判断是否需要重新拉起参数表单
let lastExportModel = '';
let lastClasses: ClsInfo[] = [];

function getSession(name: string): Session {
  let s = sessions.get(name);
  if (s) return s;
  const wrap = document.createElement('div');
  wrap.className = 'session';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg') as unknown as SVGSVGElement;
  const viewport = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  const panelsG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  const nodesG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  const edgesG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  viewport.append(panelsG, nodesG, edgesG);
  svg.appendChild(viewport);
  wrap.appendChild(svg);
  graphArea.appendChild(wrap);
  // marker 箭头定义在基础 #svg 的 defs 中，各会话 svg 通过 CSS url(#arrow) 跨引用
  const view = new GraphView(new GraphModel(), {
    svg,
    viewport,
    panelsG,
    edgesG,
    nodesG,
    graphArea: wrap,
    details: detailsEl,
    tree: treeEl,
  }, {
    // 输入形状在预览界面内提交，重导出后由扩展推送新数据
    applyShape: shape => vscode.postMessage({ type: 'input', shape }),
    // 构造参数表单（右下角常驻）：回填最近提交的参数，可重新编辑后再次导出
    getArgs: model => lastArgsByModel.get(model),
    submitArgs: (model, args) => {
      lastArgsByModel.set(model, args);
      lastExportModel = model;
      vscode.postMessage({ type: 'export', model, args });
    },
  });
  view.init();
  const formLayer = document.createElement('div');
  formLayer.className = 'tv-form-layer';
  wrap.appendChild(formLayer);
  s = { wrap, view, formLayer };
  sessions.set(name, s);
  return s;
}

function setActiveSession(s: Session): void {
  if (activeSession === s) return;
  for (const t of sessions.values()) t.wrap.style.display = t === s ? 'block' : 'none';
  activeSession = s;
  s.view.activate();
}

// 顶部 tab：同文件多个 nn.Module 之间切换（请求扩展重导出对应类）
const tabs = document.getElementById('model-tabs')!;
type ClsInfo = NonNullable<GraphData['classes']>[number];
function renderTabs(classes: ClsInfo[] | undefined, current?: string): void {
  const list = classes || [];
  // 仅一个模型时没有切换意义，隐藏 tab 悬浮层
  if (list.length < 2) {
    tabs.style.display = 'none';
    return;
  }
  tabs.style.display = '';
  tabs.innerHTML = '';
  for (const c of list) {
    const b = document.createElement('button');
    b.className = 'tab' + (c.name === current ? ' active' : '');
    b.textContent = c.name;
    if (!c.instantiable) b.title = t('Requires constructor args', '需要构造参数');
    b.addEventListener('click', () => {
      lastExportModel = c.name;
      vscode.postMessage({ type: 'export', model: c.name });
    });
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
(window as unknown as { __tv?: unknown }).__tv = {
  sessions,
  getActive: () => activeSession,
};

// 加载遮罩：解析期间显示进度（转圈 + 文字），失败显示错误（点击空白处隐藏，不做文字提示）
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
  if (t) t.textContent = message;
}
// 表单填写期间出错（如导出失败）：错误提示显示在当前会话的表单内，表单保留供修改重填，不关闭
function showFormError(message: string): void {
  const layer = activeSession?.formLayer;
  if (!layer) {
    showLoadError(message);
    return;
  }
  const hint = layer.querySelector('.f-error') as HTMLElement | null;
  if (hint) hint.textContent = message;
  const btn = layer.querySelector('.f-apply') as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = false;
    btn.textContent = t('Export', '导出');
  }
}
// 构造参数表单：需要传参的 nn.Module 逐参数输入（Python 字面量，默认值预填）
// 表单渲染进所属会话的 formLayer（tab content 的一部分，随 tab 整体切换）；已有同模型表单则直接显示，保留已填内容
function renderForm(s: Session, model: string, classes: ClsInfo[]): void {
  const layer = s.formLayer;
  if (layer.dataset.model === model && layer.querySelector('.tv-form')) {
    layer.style.display = 'flex';
    return;
  }
  layer.dataset.model = model;
  layer.style.display = 'flex';
  const cls = classes.find(c => c.name === model);
  const params = cls?.params || [];
  layer.innerHTML = `<div class="tv-loading-text"><b>${esc(model)}</b> ${t('Constructor Args', '构造参数')}</div><div class="tv-form"></div>`;
  const form = layer.querySelector('.tv-form') as HTMLElement;
  const inputs = new Map<string, HTMLInputElement>();
  // 签名解析失败（params 为空）时退化为单个自由输入框：用户直接填完整构造参数
  let rawInput: HTMLInputElement | undefined;
  if (!params.length) {
    const row = document.createElement('div');
    row.className = 'f-row';
    const label = document.createElement('span');
    label.className = 'f-label';
    label.textContent = t('Constructor args', '构造参数');
    rawInput = document.createElement('input');
    rawInput.className = 'f-input';
    rawInput.spellcheck = false;
    rawInput.placeholder = t('Arg dict: channels=8, kernel_size=3', '参数字典：channels=8, kernel_size=3');
    row.append(label, rawInput);
    form.appendChild(row);
  }
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
      // 预填优先级：上次提交值 > 类默认值（尽量沿用上次填写）
      input.value = lastArgsByModel.get(model)?.[p.name] ?? p.default ?? '';
      input.placeholder = p.required ? t('Required, Python literal', '必填，Python 字面量') : t('Leave empty for default', '留空用默认值');
      inputs.set(p.name, input);
    row.append(label, input);
    form.appendChild(row);
  }
  const applyRow = document.createElement('div');
  applyRow.className = 'f-actions';
  const btn = document.createElement('button');
  btn.className = 'f-apply';
  btn.textContent = t('Export', '导出');
  const hint = document.createElement('div');
  hint.className = 'f-hint';
  hint.textContent = t(
    "Values are Python literals: numbers as-is, strings quoted (e.g. 'imagenet'), lists like [3, 4]",
    '值为 Python 字面量：数字直接写，字符串带引号（如 \'imagenet\'），列表如 [3, 4]'
  );
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
      btn.textContent = t('Exporting…', '导出中…');
      lastExportModel = model;
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
    btn.textContent = t('Exporting…', '导出中…');
    lastArgsByModel.set(model, args);
    lastExportModel = model;
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
  if (!gotMessage)
    showLoadError(
      t(
        'No response from the extension for a long time: check the output panel (TorchViewer), or re-run the command',
        '扩展侧长时间无响应：请查看输出面板（TorchViewer）排查，或重新运行命令'
      )
    );
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
    const data = m2.data as GraphData;
    const name = String(data.model || data.classes?.[0]?.name || '');
    if (data.classes?.length) lastClasses = data.classes;
    lastExportModel = name;
    // 扩展/调试服务随数据附带实际使用的构造参数 → 回填表单记忆（右下角表单与再次弹表单的预填来源）
    const extra = data as unknown as { __tvArgs?: Record<string, string> };
    if (extra.__tvArgs && Object.keys(extra.__tvArgs).length) lastArgsByModel.set(name, extra.__tvArgs);
    const s = getSession(name);
    const key = String((data as unknown as { __tvKey?: string }).__tvKey || '');
    setActiveSession(s);
    // 导出成功：隐藏该会话的表单层，显示结构图
    s.formLayer.style.display = 'none';
    if (s.lastKey !== key || !key) {
      // 新数据（首次导出 / 参数或文件变更）→ 渲染进该会话；已有会话 DOM 不受影响
      s.lastKey = key;
      s.view.onData(data);
    }
    // 同一份数据重复推送（切回 tab 命中缓存）→ 只切换可见性，不重渲染
    renderTabs(data.classes, name);
  } else if (m2.type === 'progress') {
    // 表单填写期间忽略进度消息，保持表单原样（表单提交后按钮已是"导出中…"）
    if (!formActive) showProgress(String(m2.text || t('Parsing…', '正在解析…')));
  } else if (m2.type === 'error') {
    if (formActive) showFormError(String(m2.message || t('Parsing failed', '解析失败')));
    else {
      // 自动导出失败（如记忆参数与新输入不匹配）：该模型需要传参 → 重新拉起参数表单
      //（已有表单则原样恢复，保留用户编辑），错误内联显示在表单内；否则走全屏错误
      const cls = lastClasses.find(c => c.name === lastExportModel);
      if (cls && !cls.instantiable) {
        hideProgress();
        formActive = true;
        const s = getSession(lastExportModel);
        setActiveSession(s);
        renderForm(s, lastExportModel, lastClasses);
        showFormError(String(m2.message || t('Parsing failed', '解析失败')));
      } else showLoadError(String(m2.message || t('Parsing failed', '解析失败')));
    }
  } else if (m2.type === 'tabs') {
    lastClasses = m2.classes || [];
    renderTabs(m2.classes, m2.model);
  } else if (m2.type === 'form' && m2.model) {
    // 表单是 tab content 的一部分：切换到该会话（图区显示表单，左树/右详情切到本会话空状态）
    const name = String(m2.model);
    lastExportModel = name;
    lastClasses = m2.classes || lastClasses;
    const s = getSession(name);
    setActiveSession(s);
    hideProgress();
    formActive = true;
    renderForm(s, name, m2.classes || []);
    renderTabs(m2.classes, name);
  }
});

vscode.postMessage({ type: 'ready' });
