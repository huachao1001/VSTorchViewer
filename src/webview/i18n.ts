// webview 侧文案：语言由扩展在 HTML 内注入（window.__TV_LOCALE__），浏览器调试页兜底 navigator.language
const ZH = /^zh/i.test(
  String((window as unknown as { __TV_LOCALE__?: string }).__TV_LOCALE__ || navigator.language)
);

/** 文案：t('英文', '中文') */
export function t(en: string, zh: string): string {
  return ZH ? zh : en;
}
