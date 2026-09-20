import { useEffect, useState, type ReactNode } from 'react';
import { useApp } from '../store/app';
import { X } from 'lucide-react';

export function Pill({ kind, children }: { kind: 'success' | 'warning' | 'error' | 'info' | 'muted'; children: ReactNode }) {
  return <span className={`pill pill-${kind}`}>{children}</span>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><h2>{title}</h2>{children}</div>;
}

export function Modal({ title, onClose, children, footer, width }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={width ? { width: `min(${width}px, 92vw)` } : undefined} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header"><span>{title}</span><button className="icon-btn" onClick={onClose} aria-label="关闭" title="关闭"><X size={17} /></button></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

/** 破坏性操作：需输入名称确认 */
export function ConfirmDestructive({ title, expected, onConfirm, onClose, children, confirmLabel }: { title: string; expected: string; onConfirm: () => void | Promise<void>; onClose: () => void; children?: ReactNode; confirmLabel?: string }) {
  const [v, setV] = useState('');
  const [busy, setBusy] = useState(false);
  const confirm = async (): Promise<void> => {
    if (busy || v.trim() !== expected) return;
    setBusy(true);
    try { await onConfirm(); } finally { setBusy(false); }
  };
  return (
    <Modal title={title} onClose={onClose} footer={<><button className="btn btn-secondary" disabled={busy} onClick={onClose}>取消</button><button className="btn btn-danger" disabled={busy || v.trim() !== expected} onClick={() => void confirm()}>{busy ? '处理中…' : confirmLabel ?? '确认删除'}</button></>}>
      {children}
      <div className="field" style={{ marginTop: 12 }}><label>输入“{expected}”以确认</label><input className="input" value={v} onChange={e => setV(e.target.value)} autoFocus /></div>
    </Modal>
  );
}

export function Toasts() {
  const toasts = useApp(s => s.toasts); const dismiss = useApp(s => s.dismissToast);
  return <div className="toasts">{toasts.map(t => <div key={t.id} className={`toast ${t.kind}`} role="status">{t.text}<button className="icon-btn" style={{ pointerEvents: 'auto', marginLeft: 8 }} onClick={() => dismiss(t.id)} aria-label="关闭提示" title="关闭提示"><X size={13}/></button></div>)}</div>;
}

/** 阅读视图只显示正文；排版标记仍保留在原始文本、编辑器和导出数据中。 */
export function MarkedText({ text, ruby }: { text: string; ruby?: {start:number;end:number;rt:string}[] | undefined }) {
  if(ruby?.length){
    const plain=text.replace(/⟦\/?\d+⟧/g,'');let end=0;const parts:ReactNode[]=[];
    for(const [i,r] of [...ruby].sort((a,b)=>a.start-b.start).entries()){
      if(r.start<end||r.end>plain.length||r.end<=r.start)continue;
      parts.push(plain.slice(end,r.start),<ruby key={i}>{plain.slice(r.start,r.end)}<rt>{r.rt}</rt></ruby>);end=r.end;
    }
    parts.push(plain.slice(end));return <>{parts}</>;
  }
  const parts = text.split(/(⟦\/?\d+⟧)/g);
  return <>{parts.map((p, i) => /^⟦\/?\d+⟧$/.test(p) ? null : <span key={i}>{p}</span>)}</>;
}

export function Progress({ value, max, success }: { value: number; max: number; success?: boolean }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return <div className={`progress${success ? ' success' : ''}`} title={`${value}/${max}`}><i style={{ width: `${pct}%` }} /></div>;
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return <label className="switch"><input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} /><span>{label}</span></label>;
}

export const fmtUsd = (n: number): string => n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
export const fmtTokens = (n: number): string => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
export const fmtTime = (iso: string): string => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`; };
