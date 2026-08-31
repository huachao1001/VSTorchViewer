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
