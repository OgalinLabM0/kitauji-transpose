import { useState } from 'react';
export interface DraftStatusProps {
  stored: boolean; conflict: boolean; error: string; text: string; busy?: boolean; malformed?: boolean; current?: string;
  clear(): boolean; rebase(): void;
}
export function DraftStatus({ draft }: { draft: DraftStatusProps }) {
  const [discard, setDiscard] = useState(false);
  const [copyError, setCopyError] = useState('');
  if (!draft.stored && !draft.error) return null;
  return <div className="notice small" style={{ marginBlock: 8 }} data-draft-status>
    <span>未提交输入已保留，切换页面或关闭编辑不会丢弃。</span>
    {(draft.conflict || draft.malformed) && <div role="alert">当前对象资料已变化或草稿格式不兼容。请先对照；草稿不会自动覆盖当前资料。
      {draft.current && <details><summary>查看当前已保存内容</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{draft.current}</pre></details>}
      {draft.conflict && !draft.malformed && <button className="btn btn-secondary btn-sm" disabled={draft.busy} onClick={draft.rebase}>已对照，以当前资料为基准保留输入</button>}
    </div>}
    {draft.error && <p role="alert">{draft.error}</p>}
    <div className="row wrap"><button className="btn btn-secondary btn-sm" onClick={async () => { try { await navigator.clipboard.writeText(draft.text); setCopyError('已复制'); } catch { setCopyError('复制失败，请展开草稿并手动选择复制。'); } }}>复制草稿</button>
      <button className="btn btn-text btn-sm" disabled={draft.busy} onClick={() => setDiscard(true)}>丢弃草稿…</button>
      {discard && <><span>确认永久丢弃这份未提交输入？</span><button className="btn btn-danger btn-sm" disabled={draft.busy} onClick={() => { if (draft.clear()) setDiscard(false); }}>确认丢弃</button><button className="btn btn-text btn-sm" onClick={() => setDiscard(false)}>保留</button></>}
      {copyError && <span role="status">{copyError}</span>}
    </div>
    <details><summary>查看可复制草稿</summary><textarea className="input" readOnly value={draft.text} style={{ minHeight: 80 }} aria-label="可复制草稿" /></details>
  </div>;
}
