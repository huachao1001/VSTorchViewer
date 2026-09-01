// 扩展主进程文案：跟随 VS Code 显示语言（zh 开头 → 中文，其余 → 英文）
import * as vscode from 'vscode';

export const isZh: boolean = /^zh/i.test(vscode.env.language);

/** 文案：t('英文', '中文') */
export function t(en: string, zh: string): string {
  return isZh ? zh : en;
}
