import { create } from 'zustand';
import type { BackupSummary, LibraryIdentity } from '@shared/ipc';
import { api } from '../api';
import { loadCurrentLibrary, useApp } from './app';
import { draftIdentity, refreshDraftIdentity } from './draftIdentityBridge';
import { sameLibraryIdentity } from './draftIdentity';

type Candidate = { path: string; summary: BackupSummary };
interface BackupMaintenanceState {
  busy: boolean;
  candidate: Candidate | null;
  confirmation: string;
  confirmedIdentity: LibraryIdentity | null;
  result: string;
  error: string;
}
/** Only maintenance inputs/results survive object-form unmounts; never object drafts. */
export const useBackupMaintenance = create<BackupMaintenanceState>(() => ({ busy: false, candidate: null, confirmation: '', confirmedIdentity: null, result: '', error: '' }));

function canAct(token: string): boolean {
  return draftIdentity.isCurrent(token) && !useBackupMaintenance.getState().busy && !useApp.getState().progress.running;
}
export function setBackupConfirmation(value: string, token: string): void {
  if (!canAct(token)) return;
  useBackupMaintenance.setState({ confirmation: value, confirmedIdentity: draftIdentity.snapshot().identity });
}
export function closeBackupConfirmation(token: string): void {
  if (!canAct(token)) return;
  useBackupMaintenance.setState({ candidate: null, confirmation: '', confirmedIdentity: null });
}
export async function chooseBackup(restore: boolean, token: string): Promise<void> {
  if (!canAct(token)) return;
  useBackupMaintenance.setState({ busy: true, error: '', result: '' });
  try {
    if (restore) {
      const value = await api.app.pickBackup();
      if (value && draftIdentity.isCurrent(token)) useBackupMaintenance.setState({ candidate: value, confirmation: '', confirmedIdentity: null });
    } else {
      const value = await api.app.createBackup();
      if (value) useBackupMaintenance.setState({ result: `已备份 ${value.summary.volumes} 册、${value.summary.paragraphs} 段：${value.path}` });
    }
  } catch (e) {
    useBackupMaintenance.setState({ error: e instanceof Error ? e.message : String(e) });
  } finally {
    // A rejected native operation may never emit ready. Verify the unchanged library too.
    if (!restore && !draftIdentity.isCurrent(token)) await refreshDraftIdentity(loadCurrentLibrary);
    useBackupMaintenance.setState({ busy: false });
  }
}
export async function restoreSelectedBackup(token: string): Promise<void> {
  if (!canAct(token)) return;
  const { candidate, confirmation, confirmedIdentity } = useBackupMaintenance.getState();
  if (!candidate || confirmation.trim() !== '恢复') return;
  if (!sameLibraryIdentity(confirmedIdentity, draftIdentity.snapshot().identity)) {
    useBackupMaintenance.setState({ confirmation: '', confirmedIdentity: null, error: '当前书库已变化，请重新输入“恢复”确认。' });
    return;
  }
  useBackupMaintenance.setState({ busy: true, error: '', result: '' });
  draftIdentity.invalidate(); // Synchronously reject every captured object-form callback.
  try {
    const restored = await api.app.restoreBackup(candidate.path, candidate.summary.hash);
    useBackupMaintenance.setState({ result: `已恢复 ${restored.summary.volumes} 册。恢复前副本：${restored.safetyPath}`, candidate: null, confirmation: '', confirmedIdentity: null });
    useApp.getState().toast('success', '书库已恢复，未完成任务等待手动继续。');
  } catch (e) {
    // Keep the external file, hash and explicit confirmation for same-library retry.
    useBackupMaintenance.setState({ error: e instanceof Error ? e.message : String(e) });
  } finally {
    await refreshDraftIdentity(loadCurrentLibrary);
    useBackupMaintenance.setState({ busy: false });
  }
}
