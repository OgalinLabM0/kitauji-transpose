import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { loadCurrentLibrary } from '../store/app';
import { connectDraftIdentity, draftIdentity, refreshDraftIdentity } from '../store/draftIdentityBridge';
import { useBackupMaintenance } from '../store/backupMaintenance';
import { DraftRecovery } from './DraftRecovery';

/** Remount object forms only after identity AND current library data are verified. */
export function DraftIdentityBoundary({ children }: { children: ReactNode }) {
  const scope = useSyncExternalStore(draftIdentity.subscribe, draftIdentity.snapshot);
  const { busy, result, error, candidate } = useBackupMaintenance();
  useEffect(() => connectDraftIdentity(loadCurrentLibrary), []);
  return <>
    {scope.status !== 'ready' && (busy || result || error) && <section aria-label="书库维护结果" className="card" style={{ margin: 16, overflowWrap: 'anywhere' }}>
      {busy && <p role="status">书库备份或恢复处理中，正在等待操作和身份核对完成。</p>}
      {result && <p role="status">{result}</p>}
      {error && <p role="alert">{error}{candidate ? '。所选备份仍保留，核对书库后可重试。' : ''}</p>}
    </section>}
    {scope.status !== 'ready' ? <main style={{ padding: 24 }}>
      <h1>核对书库身份</h1>
      <p role="status">{scope.error || (scope.status === 'blocked' ? '书库维护中，暂不载入或提交草稿。历史输入仍保留。' : '正在读取书库身份和当前资料，暂不载入草稿。')}</p>
      <DraftRecovery />
      {(scope.status === 'error' || scope.status === 'blocked') && <button className="btn btn-secondary" disabled={busy} onClick={() => void refreshDraftIdentity(loadCurrentLibrary)}>重试读取书库</button>}
    </main> : <div key={scope.token} style={{ display: 'contents' }}>{children}</div>}
  </>;
}
