// 算子分类与配色：图例与卡片色条的唯一来源
import type { GNode } from './types';

interface Cat {
  label: string;
  color: string;
  re: RegExp;
}

export const CATS: Cat[] = [
  { label: '卷积', color: '#5b7fb9', re: /conv/i },
  { label: '全连接', color: '#9575ba', re: /linear/i },
  { label: '归一化', color: '#63a893', re: /norm/i },
  { label: '池化', color: '#c08a56', re: /pool/i },
  { label: '激活', color: '#b3a15e', re: /relu|gelu|sigmoid|tanh|softmax|silu|leaky|elu|hardscale|hardswish|mish/i },
  { label: '注意力/RNN', color: '#7186c9', re: /attention|lstm|rnn|gru/i },
  { label: '嵌入', color: '#bd6f92', re: /embed/i },
  { label: '形状操作', color: '#7d9199', re: /flatten|reshape|view|squeeze|unsqueeze|permute|transpose|cat|concat|stack|split|chunk|pad|getitem/i },
  { label: '算术', color: '#8a99a5', re: /matmul|add|mul|div|sub|mean|sum|clamp|pow|sqrt|exp|log|abs|min|max|neg/i },
];

export function nodeColor(nd: GNode): string {
  if (nd.kind === 'module-cluster') return '#6e5a8e'; // 组合卡片：深紫，与算子分类色区分
  if (nd.kind === 'placeholder') return '#6aa877';
  if (nd.kind === 'output') return '#c26a63';
  // 先按算子类名分类；模块路径（target）仅作兜底——路径可能含 "conv" 等误导片段
  const cls = (nd.cls || '').toLowerCase();
  for (const cat of CATS) if (cat.re.test(cls)) return cat.color;
  const target = (nd.target || '').toLowerCase();
  for (const cat of CATS) if (cat.re.test(target)) return cat.color;
  return '#7f919e';
}
