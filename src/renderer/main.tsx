import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/app.css';

async function mount() {
  const { App } = await import('./App');
  if (import.meta.env.DEV && import.meta.env.MODE === 'browser-preview' && import.meta.env.VITE_BROWSER_PREVIEW === 'true') {
    const { PreviewShell } = await import('./preview/PreviewShell');
    createRoot(document.getElementById('root')!).render(<StrictMode><PreviewShell><App /></PreviewShell></StrictMode>);
  } else {
    createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
  }
}
void mount().catch(error => {
  const root = document.getElementById('root');
  if (root) {
    root.setAttribute('role', 'alert');
    root.style.padding = '24px';
    root.textContent = `界面启动失败：${error instanceof Error ? error.message : '未知错误'}`;
  }
});
