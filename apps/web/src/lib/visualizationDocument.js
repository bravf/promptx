// 沙箱仅开放脚本，不开放同源、弹窗、表单、下载或顶层导航权限。
export const VISUALIZATION_SANDBOX = 'allow-scripts'
export const VISUALIZATION_CDN_SCRIPTS = [
  'https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.8/dist/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/echarts@5.6.0/dist/echarts.min.js',
]

export function createVisualizationDocument(html, { token, colors = {}, dark = false } = {}) {
  // template 内容保持惰性，避免解析时在父页面提前请求图片等资源。
  const template = document.createElement('template')
  template.innerHTML = html
  // CSP 在任何源内容之前生效；移除可改变文档目的地的声明。
  template.content.querySelectorAll('base, meta[http-equiv], iframe, frame, frameset, object, embed, portal, link').forEach(node => node.remove())
  const policy = document.createElement('meta')
  policy.httpEquiv = 'Content-Security-Policy'
  policy.content = `default-src 'none'; script-src 'unsafe-inline' ${VISUALIZATION_CDN_SCRIPTS.join(' ')}; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; media-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`
  const charset = document.createElement('meta')
  charset.setAttribute('charset', 'UTF-8')
  const viewport = document.createElement('meta')
  viewport.name = 'viewport'; viewport.content = 'width=device-width, initial-scale=1'
  const style = document.createElement('style')
  const variables = {
    background: colors.appPanel, foreground: colors.textPrimary,
    'muted-foreground': colors.textMuted, border: colors.borderDefault,
    card: colors.appPanelMuted, 'card-foreground': colors.textPrimary,
    muted: colors.appPanelMuted, primary: colors.primaryBg, 'primary-foreground': colors.primaryText,
    secondary: colors.appPanelStrong, 'secondary-foreground': colors.textPrimary,
    'accent-foreground': colors.textPrimary, accent: colors.accentSoft, ring: colors.accent,
    'color-background-primary': colors.appPanel, 'color-background-secondary': colors.appPanelMuted,
    'color-text-primary': colors.textPrimary, 'color-text-secondary': colors.textMuted,
    'color-border-primary': colors.borderDefault,
    'viz-series-1': colors.accent, 'viz-series-2': '#5b8bd9', 'viz-series-3': '#c99537',
    'viz-series-4': '#a779c9', 'viz-series-5': '#db7770', 'viz-series-6': '#55a8a0',
  }
  const cssVariables = Object.entries(variables).filter(([, value]) => /^#[a-f\d]{3,8}$/i.test(value || '')).map(([key, value]) => `--${key}:${value}`).join(';')
  style.textContent = `:root{color-scheme:${dark ? 'dark' : 'light'};--font-size-base:14px;--radius:4px;${cssVariables}}*{box-sizing:border-box}body{margin:0;padding:20px;background:var(--background);color:var(--foreground);font:14px/1.6 system-ui,sans-serif;overflow-wrap:anywhere}svg,canvas,img{max-width:100%}button,input,select,textarea{font:inherit;color:inherit}button{cursor:pointer}pre{white-space:pre-wrap}.text-small{font-size:12px}.text-muted{color:var(--muted-foreground)}.card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:16px}.btn{background:var(--secondary);border:1px solid var(--border);border-radius:var(--radius);padding:6px 12px}.btn-primary{background:var(--primary);color:var(--primary-foreground)}@media(max-width:600px){body{padding:12px}}`
  const bridge = document.createElement('script')
  bridge.textContent = `(() => {
    const token = ${JSON.stringify(token)};
    const send = type => parent.postMessage({ source: 'promptx-visualization', token, type }, '*');
    // 仅在本次预览内保存展示状态，不桥接宿主会话或工具调用。
    let widgetState = null;
    window.openai = {
      get widgetState() { return widgetState; },
      async setWidgetState(value) {
        const json = JSON.stringify(value);
        if (new TextEncoder().encode(json).length > 16384) throw new Error('图表状态超过 16 KiB');
        widgetState = JSON.parse(json);
      },
      async sendFollowUpMessage() { send('unsupported'); throw new Error('PromptX 暂不支持从图表发起会话消息'); },
    };
    addEventListener('error', () => send('error'), true);
    addEventListener('unhandledrejection', () => send('error'));
    addEventListener('securitypolicyviolation', () => send('blocked'));
    addEventListener('load', () => send('ready'));
    addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); send('close'); } });
    document.addEventListener('click', event => { if (event.target.closest?.('a,area')) event.preventDefault(); }, true);
    document.addEventListener('submit', event => event.preventDefault(), true);
  })();`
  return `<!doctype html><html><head>${policy.outerHTML}${charset.outerHTML}${viewport.outerHTML}${style.outerHTML}${bridge.outerHTML}</head><body>${template.innerHTML}</body></html>`
}
