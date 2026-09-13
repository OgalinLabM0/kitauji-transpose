import type { Api } from '@shared/ipc';

declare global { interface Window { api: Api } }

// All three compile-time switches are required. Vite removes the dynamic preview
// import from production builds, even if a developer leaves the env flag set.
async function resolveApi(): Promise<Api> {
  if (import.meta.env.DEV && import.meta.env.MODE === 'browser-preview' && import.meta.env.VITE_BROWSER_PREVIEW === 'true') {
    if (window.api || window.location.hostname !== '127.0.0.1' || window.location.protocol !== 'http:') {
      throw new Error('浏览器预览仅允许在独立的 http://127.0.0.1 开发页面运行，不能连接 Electron 原生接口。');
    }
    const { createPreviewApi, PREVIEW_NOTICE_EVENT } = await import('./preview/adapter');
    return createPreviewApi(message => window.dispatchEvent(new CustomEvent(PREVIEW_NOTICE_EVENT, { detail: message })));
  }
  if (!window.api) throw new Error('原生接口不可用。请启动 Electron 应用；需要隔离的浏览器演示时，请显式运行 npm run dev:preview。');
  return window.api;
}

export const api: Api = await resolveApi();
