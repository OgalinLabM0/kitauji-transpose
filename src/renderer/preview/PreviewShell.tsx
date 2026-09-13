import { useEffect, useState, type ReactNode } from 'react';
import { PREVIEW_NOTICE_EVENT } from './adapter';
import './preview.css';

export function PreviewShell({ children }: { children: ReactNode }) {
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const receive = (event: Event) => { if (event instanceof CustomEvent && typeof event.detail === 'string') setNotice(event.detail); };
    window.addEventListener(PREVIEW_NOTICE_EVENT, receive);
    return () => window.removeEventListener(PREVIEW_NOTICE_EVENT, receive);
  }, []);
  return <div className="preview-shell">
    <aside className="preview-banner" aria-label="浏览器预览模式">
      <strong>浏览器预览 · 只读演示数据</strong>
      <span>未连接正式书库、AI 服务或本机文件。所有业务写入与原生操作均禁用，请勿填写真实密钥。</span>
      <small>所有译文均为未验收样例，包含故意保留的错误，不表示检查通过。输入框草稿可能保留在此浏览器；外观与选书仅保留本次会话。</small>
    </aside>
    {notice && <div className="preview-denial" role="alert"><span>{notice}</span><button type="button" onClick={() => setNotice('')}>关闭提示</button></div>}
    {children}
  </div>;
}
