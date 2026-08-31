// TorchViewer webview 入口：装配模型 / 视图 / 侧边栏，处理与扩展主进程的消息
// 架构：
//   GraphModel   —— 数据模型（层级折叠、dagre 布局、背景盒后处理、选中解析）
//   GraphView    —— 视图控制器（渲染循环、缩放平移、交互、选中高亮、搜索）
//   render/*     —— SVG 构建器（节点 / 连线 / 组合背景 / 图例）
//   sidebar/*    —— 详情面板 / 模块树
import { GraphModel } from './graph-model';
import { GraphView } from './view/graph-view';
import type { GraphData } from './types';

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
});
view.init();

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

window.addEventListener('message', e => {
  const m = e.data;
  if (m.type === 'data' && m.data) view.onData(m.data as GraphData);
});

vscode.postMessage({ type: 'ready' });
