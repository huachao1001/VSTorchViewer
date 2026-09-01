// 节点度量：输入/输出判定、形状文本、卡片尺寸（布局与渲染共用的唯一事实来源）
import type { GNode } from './types';
import { clamp, fmtNum, fmtShape, textW } from './utils';
import { FONT_NAME, FONT_SHAPE, FONT_SUMMARY, FONT_TYPE } from './utils';
import { t } from './i18n';

export function isIO(nd: GNode): boolean {
  return nd.kind === 'placeholder' || nd.kind === 'output';
}

export function shapeStr(nd: GNode): string | undefined {
  const s = nd.out_shape ?? nd.shape;
  return s && s.length ? fmtShape(s) : undefined;
}

export function sizeNode(nd: GNode): void {
  if (isIO(nd)) {
    const head = nd.kind === 'placeholder' ? t('Input · ', '输入 · ') : t('Output · ', '输出 · ');
    const shp = shapeStr(nd);
    const label = head + '「' + (nd.name || '') + '」';
    const w = Math.max(textW(label, FONT_NAME), shp ? textW(shp, FONT_SHAPE) : 0);
    nd.w = clamp(w + 34, 110, 240);
    nd.h = 38;
    return;
  }
  // Netron 风格卡片：标题栏（类名 + 参数量）+ 分隔线 + 信息行（摘要 / 形状）
  // 聚合卡片标题与渲染一致：只取模块路径最后一级
  const head = nd.kind === 'module-cluster' ? (nd.name || '').split('.').pop() || nd.cls || nd.kind || '' : nd.cls || nd.kind || '';
  let w = textW(head, FONT_NAME);
  if (nd.params !== undefined) w = Math.max(w, 60 + textW(fmtNum(nd.params), FONT_TYPE) + 8);
  if (nd.summary) w = Math.max(w, textW(nd.summary, FONT_SUMMARY));
  const shp = shapeStr(nd);
  if (shp) w = Math.max(w, textW(shp, FONT_SHAPE));
  nd.w = clamp(w + 24, 120, 280);
  const rows = (nd.summary ? 1 : 0) + (shp ? 1 : 0);
  nd.h = 24 + 1 + rows * 15 + 9;
}
