import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { api } from '../api';
import { useApp } from '../store/app';
import { drafts } from '../store/useDraft';
import { draftIdentity } from '../store/draftIdentityBridge';
import { publishReviewDraftTarget } from '../store/reviewDraftNavigation';
import { draftMatchesLibrary, type LocalDraft } from '../store/drafts';
import type { DraftLocation } from '../store/drafts';
import { Modal } from './ui';

const useTarget = create<{ location: DraftLocation | null; sequence: number; token: string | null }>(() => ({ location: null, sequence: 0, token: null }));
export function useDraftTarget(page: DraftLocation['page'], apply: (objectId: string) => void): void {
  const { location, sequence, token } = useTarget();
  const callback = useRef(apply); callback.current = apply;
  useEffect(() => { if (token && draftIdentity.isCurrent(token) && location?.page === page && location.objectId) callback.current(location.objectId); }, [page, location, sequence, token]);
}
export function DraftRecovery() {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [discard, setDiscard] = useState<string | null>(null);
  useSyncExternalStore(drafts.subscribe, drafts.snapshot);
  const series = useApp(s => s.series);
  const scope = useSyncExternalStore(draftIdentity.subscribe, draftIdentity.snapshot);
  const [locating, setLocating] = useState(false);
  const request = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current++; }; }, []);
  useEffect(() => { request.current++; setLocating(false); setMessage(''); }, [scope.token]);
  let rows: ReturnType<typeof drafts.list> = [], error = '';
  try { rows = drafts.list().sort((a, b) => (b.record.updatedAt ?? 0) - (a.record.updatedAt ?? 0)); error = drafts.listError; }
  catch { error = '草稿列表读取失败；正在编辑的输入请先保存或复制。'; }
  const locate = async (location: DraftLocation, record: LocalDraft) => {
    const token = scope.token;
    const attempt = ++request.current;
    const current = () => mounted.current && request.current === attempt && draftIdentity.isCurrent(token);
    setLocating(true); setMessage('');
    try {
      if (!draftIdentity.isCurrent(token) || !draftMatchesLibrary(record, scope.identity)) throw new Error('这份草稿没有当前书库及恢复代数凭证；仅可复制后人工核对，不能按相同对象编号定位。');
      if (location.seriesId && !series.some(s => s.id === location.seriesId)) throw new Error('原作品在当前书库中不存在；请复制草稿自行核对，不能套用到其他作品。');
      if (location.page === 'glossary' && location.objectId && location.objectId !== 'new-term') {
        if (!(await api.glossary.list(location.seriesId!)).some(t => t.id === location.objectId)) throw new Error('原术语已不存在；草稿仍保留，可复制后手动核对。');
      }
      if (location.page === 'knowledge' && location.objectId && !['new-character', 'new-address'].includes(location.objectId)) {
        const exists = location.objectId.startsWith('end-address:')
          ? (await api.knowledge.addresses(location.seriesId!)).some(a => a.id === location.objectId!.slice('end-address:'.length) && a.validToPara == null)
          : (await api.knowledge.characters(location.seriesId!)).some(c => c.id === location.objectId);
        if (!exists) throw new Error('原人物或未结束称呼已不存在；草稿仍保留，可复制后手动核对。');
      }
      if (!current()) return;
      if (location.page === 'workbench' && location.objectId) await useApp.getState().jumpToParagraph(location.objectId);
      else if (location.page === 'review' && location.objectId) {
        if (!location.seriesId) throw new Error('草稿缺少原作品信息，仅可复制核对。');
        const groups = await Promise.all((['pending', 'resolved', 'dismissed'] as const).map(status => api.review.list(location.seriesId!, status)));
        if (!current()) return;
        const item = groups.flat().find(item => item.id === location.objectId);
        if (!item) throw new Error('原复核项已不存在；草稿仍保留，请复制后自行核对。');
        const paragraph = item.paragraphId ? await api.project.getParagraph(item.paragraphId) : null;
        if (!current()) return;
        const owner = useApp.getState().series.find(s => s.id === location.seriesId);
        if (!owner) throw new Error('原作品在当前书库中不存在；草稿仍保留。');
        if (paragraph && !owner.volumes.some(v => v.id === paragraph.volumeId)) throw new Error('复核项原文不属于原作品，已拒绝定位。');
        // A shared item or a surviving review whose paragraph disappeared is still locatable.
        const volumeId = paragraph?.volumeId ?? null;
        useApp.getState().selectSeries(location.seriesId);
        if (volumeId) useApp.getState().selectVolume(volumeId);
        useApp.getState().setPage('review');
        publishReviewDraftTarget({ queueId: item.id, seriesId: location.seriesId, volumeId, status: item.status, token });
      } else {
        if (location.seriesId) useApp.getState().selectSeries(location.seriesId);
        useApp.getState().setPage(location.page);
      }
      if (!current()) return;
      useTarget.setState(s => ({ location, sequence: s.sequence + 1, token }));
      setOpen(false);
      useApp.getState().toast('info', '已定位原页面；历史草稿请先复制并对照当前资料，再手动填入。');
    } catch (e) { if (current()) setMessage((e as Error).message); }
    finally { if (mounted.current && request.current === attempt) setLocating(false); }
  };
  return <>
    <button className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start', margin: '6px 16px' }} onClick={() => setOpen(true)}>找回草稿{rows.length ? `（${rows.length}）` : ''}</button>
    {open && <Modal title="找回未提交草稿" onClose={() => { request.current++; setLocating(false); setOpen(false); }}>
      <p className="small muted">草稿不是正式保存。同一书库、同一恢复代数重启后可找回输入，资料变化仍需对照。其他书库、清空或恢复之前、旧版无身份草稿只供人工复制核对，不会自动填入；历史草稿不会因此删除。</p>
      {(error || message) && <p role="status">{error || message}</p>}
      {!rows.length && <p>没有可找回的草稿。</p>}
      {rows.map(({ key, record }) => <div className="card" key={key}>
        <b style={{ overflowWrap: 'anywhere' }}>{record.location?.title ?? '旧版草稿（来源未核验）'}</b>
        <p className="small muted">{draftMatchesLibrary(record, scope.identity) ? '当前书库／同一恢复代数，仍需对照资料' : '旧版无身份／其他书库／旧恢复代数，仅可复制核对'}{record.location?.seriesId ? ` · ${series.find(s => s.id === record.location!.seriesId)?.title ?? '原作品不在当前库'}` : ''}{drafts.unsaved.has(key) ? ' · 尚未写入本地存储' : ''}</p>
        <textarea className="input" readOnly aria-label="找回的草稿" value={record.text} style={{ minHeight: 100 }} />
        <div className="row wrap"><button className="btn btn-secondary btn-sm" onClick={async () => { try { await navigator.clipboard.writeText(record.text); setMessage('草稿已复制。'); } catch { setMessage('复制失败，请在文本框中全选并复制。'); } }}>复制</button>
          {record.location && <button className="btn btn-secondary btn-sm" disabled={locating || !draftMatchesLibrary(record, scope.identity) || scope.status !== 'ready'} onClick={() => void locate(record.location!, record)}>定位原对象</button>}
          <button className="btn btn-text btn-sm" onClick={() => setDiscard(key)}>丢弃…</button>
          {discard === key && <><span>永久丢弃这份草稿？</span><button className="btn btn-danger btn-sm" onClick={() => { if (drafts.clear(key, record)) { setDiscard(null); setMessage('草稿已丢弃。'); } else setMessage('草稿已变化或删除失败，仍保留输入。'); }}>确认丢弃</button><button className="btn btn-text btn-sm" onClick={() => setDiscard(null)}>保留</button></>}
        </div>
      </div>)}
    </Modal>}
  </>;
}
