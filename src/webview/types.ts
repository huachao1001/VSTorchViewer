// 共享类型契约：模型与渲染层之间的数据结构

export interface Pt {
  x: number;
  y: number;
}

export interface GNode {
  id: number;
  name: string;
  kind?: string;
  target?: string;
  cls?: string;
  params?: number;
  attrs?: Record<string, unknown>;
  out_shape?: number[];
  shape?: number[];
  dtype?: string;
  group?: string;
  group_cls?: string;
  summary?: string;
  clusterKey?: string;
  virtual?: boolean;
  macs?: number;
  // 模块树（回退视图）专用
  children?: GNode[];
  rank?: number;
  sh?: number;
  // 布局结果
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

export interface GEdge {
  src: number;
  dst: number;
}

export interface Chain {
  src: number;
  dst: number;
  path: Pt[];
  dashed: boolean;
}

export interface Panel {
  key: string;
  label: string;
  clss: string[];
  params: number;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  nodes: GNode[];
  x?: number;
  w?: number;
  yTop?: number;
  yH?: number;
}

export interface GraphData {
  kind: 'graph' | 'tree';
  model?: string;
  warning?: string;
  inputs?: { name: string; shape?: number[] }[];
  outputs?: { name: string; shape?: number[] }[];
  nodes: GNode[];
  edges: GEdge[];
  root?: GNode;
  tree?: GNode;
  total_params?: number;
  total_macs?: number;
  total_flops?: number;
  // 文件内全部 nn.Module 候选与当前展示的类（顶部 tab 切换）；params 用于需要构造参数的类的表单
  classes?: { name: string; instantiable: boolean; params?: { name: string; required: boolean; default?: string; annotation?: string }[] }[];
}

// 全局模块树节点：左侧树面板、拓扑图折叠、选中解析的唯一结构源。
// 由导出数据的 tree（完整模块层级，含参数/缓冲叶子）+ nodes（算子按 group/target 挂载）合并构建。
export interface MNode {
  key: string; // 全路径；根为 ''
  name: string; // 最后一段；根为模型名
  kind: 'module' | 'op' | 'param' | 'buffer';
  cls?: string;
  params?: number;
  shape?: number[]; // param/buffer
  dtype?: string;
  out_shape?: number[]; // op
  node?: GNode; // op → 源图节点
  parent: MNode | null;
  children: MNode[]; // 子模块（按图执行序）
  others: MNode[]; // 参数/缓冲叶子
  ops: MNode[]; // 直属算子（图执行序）
  flowIdx: number; // 数据流首次触达序（子模块排序用）
}

// 选中记忆：跨层级传播（模块 ↔ 成员算子）
export interface Selection {
  id: number;
  group: string | null;
  isCluster: boolean;
}

export interface ResolvedSelection {
  ids: Set<number>;
  primary: GNode | null;
}
