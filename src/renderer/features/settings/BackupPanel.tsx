import { useSyncExternalStore } from 'react';
import { useApp } from '../../store/app';
import { draftIdentity } from '../../store/draftIdentityBridge';
import { chooseBackup, closeBackupConfirmation, restoreSelectedBackup, setBackupConfirmation, useBackupMaintenance } from '../../store/backupMaintenance';
import { Modal } from '../../components/ui';

export function BackupPanel() {
  const progress = useApp(s => s.progress);
  const scope = useSyncExternalStore(draftIdentity.subscribe, draftIdentity.snapshot);
  const { busy, candidate, confirmation, error, result } = useBackupMaintenance();
  const disabled = busy || progress.running || scope.status !== 'ready';
  return <div className="card"><h3>书库备份与恢复</h3>
    <p className="small muted">备份全部系列的源文件、知识、译稿、决定、检查记录和任务。API密钥和接口设置不打包；还没保存的草稿需要先保存。恢复会替换当前书库，会先自动保存当前书库的副本。</p>
    <div className="row wrap"><button className="btn btn-secondary" disabled={disabled} onClick={() => void chooseBackup(false, scope.token)}>备份全部书库</button><button className="btn btn-secondary" disabled={disabled} onClick={() => void chooseBackup(true, scope.token)}>检查备份并恢复</button></div>
    {result && <p role="status" className="small" style={{ overflowWrap: 'anywhere' }}>{result}</p>}
    {error && !candidate && <p role="alert">{error}</p>}
    {candidate && <Modal title="恢复书库" onClose={() => closeBackupConfirmation(scope.token)} footer={<><button className="btn btn-secondary" disabled={disabled} onClick={() => closeBackupConfirmation(scope.token)}>取消</button><button className="btn btn-danger" disabled={disabled || confirmation.trim() !== '恢复'} onClick={() => void restoreSelectedBackup(scope.token)}>{busy ? '处理中…' : '备份当前库并恢复'}</button></>}>
      {error && <p role="alert">{error}</p>}
      <p>所选备份含 {candidate.summary.series} 个系列、{candidate.summary.volumes} 册、{candidate.summary.paragraphs} 段、{candidate.summary.finals} 份历史译稿。恢复不会自动调用模型。请输入“恢复”确认替换。</p>
      <p className="small" style={{ overflowWrap: 'anywhere' }}>{candidate.path}</p>
      <div className="field" style={{ marginTop: 12 }}><label>输入“恢复”以确认</label><input className="input" value={confirmation} disabled={disabled} onChange={e => setBackupConfirmation(e.target.value, scope.token)} autoFocus /></div>
    </Modal>}
  </div>;
}
