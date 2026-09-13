import { useEffect, useRef, useState } from 'react';
import type { Api } from '@shared/ipc';
import type { ChapterSummary, CharacterView, ParagraphView, ReviewItemView, VolumeSummary } from '@shared/types';
import { api } from '../../api';
import { useApp } from '../../store/app';
import { currentDraftSession } from '../../store/useDraft';
import { useFormDraft } from '../../store/useFormDraft';
import { DraftStatus } from '../../components/DraftStatus';

type Preview = Awaited<ReturnType<Api['review']['previewLegacyChange']>>;
const initial = { evidence: '[]', reason: '', end: '', endId: '', endLabel: '', unlimited: false, volume: '', chapter: '' };
const kindLabels: Record<Preview['kind'], string> = { character: '人物档案', term: '术语', relationship: '人物关系', address: '称呼阶段', character_state: '人物状态' };
function evidenceIds(text: string): string[] {
  try { const ids: unknown = JSON.parse(text); return Array.isArray(ids) && ids.every(id => typeof id === 'string') ? [...new Set(ids)] : []; }
  catch { return []; }
}
function targetDescription(preview: Preview, characters: CharacterView[]): string {
  const row = preview.target;
  const name = (id: unknown) => characters.find(c => c.id === id)?.nameZh || characters.find(c => c.id === id)?.nameJp || '人物名称暂不可用';
  switch (preview.kind) {
    case 'character': return String(row.canonical_name_zh || row.canonical_name_jp || '人物档案');
    case 'term': return `${row.term_jp ?? '术语'} → ${row.term_zh ?? '尚无译名'}`;
    case 'relationship': return `${name(row.from_char_id)} → ${name(row.to_char_id)}：${row.description_jp ?? row.event_type ?? '关系阶段'}`;
    case 'address': return `${name(row.speaker_char_id)} → ${name(row.target_char_id)}：${row.source_form_jp ?? ''} → ${row.translated_form ?? ''}`;
    case 'character_state': return `${name(row.character_id)}：${row.description ?? row.state_type ?? '人物状态'}`;
  }
}

/** Manual-only local interval recovery. The historical decision is never represented as undone. */
export function LegacyChangeRecovery({ item, seriesId }: { item: ReviewItemView; seriesId: string }) {
  const running = useApp(s => s.progress.running);
  const draft = useFormDraft(`legacy-recovery-${item.id}`, initial,
    { page: 'review', seriesId, objectId: item.id, title: `${item.title} · 旧知识重新确认` },
    { queueId: item.id, seriesId, payload: item.payload, status: item.status });
  const [volumes, setVolumes] = useState<VolumeSummary[]>([]);
  const [chapters, setChapters] = useState<ChapterSummary[]>([]);
  const [paragraphs, setParagraphs] = useState<ParagraphView[]>([]);
  const [characters, setCharacters] = useState<CharacterView[]>([]);
  const [preview, setPreview] = useState<{ result: Preview; form: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [loadError, setLoadError] = useState('');
  const [retry, setRetry] = useState(0);
  const [consent, setConsent] = useState(false);
  const [undoConsent, setUndoConsent] = useState(false);
  const lock = useRef(false);
  const operation = useRef(0);
  const mounted = useRef(true);
  const session = currentDraftSession();
  const scopeCurrent = () => mounted.current && currentDraftSession() === session && useApp.getState().currentSeriesId === seriesId;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { operation.current++; lock.current = false; setBusy(false); setMessage(''); }, [session, seriesId, item.id]);
  const form = JSON.stringify(draft.value);
  const selected = evidenceIds(draft.value.evidence);
  const receipt = item.payload.legacyRecovery;
  useEffect(() => { setPreview(null); setConsent(false); setUndoConsent(false); }, [form, item.payload, session]);
  useEffect(() => {
    let live = true;
    setVolumes([]); setCharacters([]); setLoadError('');
    void Promise.all([api.project.listVolumes(seriesId), api.knowledge.characters(seriesId)]).then(([vs, cs]) => {
      if (live && scopeCurrent()) { setVolumes(vs); setCharacters(cs); }
    }).catch(e => { if (live && scopeCurrent()) setLoadError((e as Error).message); });
    return () => { live = false; };
  }, [seriesId, session, retry]);
  useEffect(() => {
    let live = true; setChapters([]);
    if (!draft.value.volume || !volumes.some(v => v.id === draft.value.volume)) return;
    void api.project.listChapters(draft.value.volume).then(cs => { if (live && scopeCurrent()) setChapters(cs); })
      .catch(e => { if (live && scopeCurrent()) setLoadError((e as Error).message); });
    return () => { live = false; };
  }, [draft.value.volume, volumes, session, retry]);
  useEffect(() => {
    let live = true; setParagraphs([]);
    if (!draft.value.chapter || !chapters.some(c => c.id === draft.value.chapter)) return;
    void api.project.listParagraphs(draft.value.chapter).then(ps => { if (live && scopeCurrent()) setParagraphs(ps); })
      .catch(e => { if (live && scopeCurrent()) setLoadError((e as Error).message); });
    return () => { live = false; };
  }, [draft.value.chapter, chapters, session, retry]);
  const change = (patch: Partial<typeof initial>) => {
    if (lock.current || running || !scopeCurrent()) return;
    setPreview(null); setConsent(false); setMessage(''); draft.change({ ...draft.value, ...patch });
  };
  const perform = async (action: 'preview' | 'save' | 'undo') => {
    if (lock.current || running || !scopeCurrent() || draft.conflict || draft.malformed) return;
    if (action === 'save' && (!preview || preview.form !== form || !consent || !draft.value.reason.trim())) return;
    if (action === 'undo' && !undoConsent) return;
    const attempt = ++operation.current;
    const current = () => scopeCurrent() && operation.current === attempt;
    lock.current = true; setBusy(true); setMessage('');
    try {
      if (action === 'preview') {
        // Bind the selected end paragraph to the same source proof and fingerprint.
        // Restored drafts must not silently apply an old ordinal to a moved/rewritten paragraph.
        const proofIds = draft.value.unlimited ? selected : [...new Set([...selected, draft.value.endId])];
        const result = await api.review.previewLegacyChange(item.id, seriesId, proofIds);
        if (!draft.value.unlimited) {
          const end = result.evidence.find(e => e.id === draft.value.endId);
          if (!end || end.at !== Number(draft.value.end) || `§${end.at} ${end.text}` !== draft.value.endLabel) throw new Error('结束段落已移动或改写，请从当前原文重新选择结束位置');
        }
        if (current()) { setPreview({ result, form }); setConsent(false); }
      } else {
        if (action === 'save') {
          await api.review.reconfirmLegacyChange(item.id, seriesId, {
            token: preview!.result.token, evidenceIds: preview!.result.evidence.map(e => e.id), reason: draft.value.reason,
            validToPara: draft.value.unlimited ? null : Number(draft.value.end),
          });
        } else await api.review.undoLegacyReconfirmation(item.id, seriesId);
        if (current()) {
          draft.clear(); setPreview(null); setConsent(false); setUndoConsent(false);
          setMessage(action === 'save' ? '本次人工新决定已保存，旧稿保留并安排重新复核。请回工作台明确点击继续；这里不会自动调用模型。' : '仅本次有快照的人工新决定已撤销，旧决定恢复为待核对状态。这里不会自动调用模型。');
        }
      }
    } catch (e) {
      if (current()) { setMessage(`${(e as Error).message}；选择与理由已保留，请重新预览核对后再提交。`); setPreview(null); setConsent(false); }
    } finally { if (operation.current === attempt) { lock.current = false; if (mounted.current) setBusy(false); } }
  };
  const disabled = busy || running;
  const endReady = draft.value.unlimited || (draft.value.endId !== '' && draft.value.end !== '' && Number.isSafeInteger(Number(draft.value.end)));
  const previewReady = !!preview && preview.form === form;
  const currentEnd = preview?.result.kind === 'character' ? preview.result.target.deactivated_at_para : preview?.result.target.valid_to_para;
  return <section aria-label="旧知识人工重新确认" className="card" style={{ marginTop: 12 }}>
    <h3>核对旧决定的有效范围</h3>
    <p>旧记录没有可靠的撤销快照，因此不能恢复未知的历史状态。你可以对照本作品原文，作出一条有理由、有快照的人工新决定；这只重新确认有效范围，不证明旧模型判断正确，也不自动认可现有译稿。</p>
    <DraftStatus draft={{ ...draft, busy, clear: () => !lock.current && draft.clear(), rebase: () => { if (!lock.current) draft.rebase(); }, current: `当前问题：${item.title}；状态：${receipt ? '已保存人工重新确认' : '旧决定待核对'}` }} />
    {message && <p role="status">{message}</p>}
    {receipt ? <>
      <p>本条已有人工重新确认快照。撤销只恢复这次新决定之前的范围，不是撤销原历史决定；有后续修改时服务端会拒绝覆盖。</p>
      <label><input type="checkbox" checked={undoConsent} disabled={disabled} onChange={e => setUndoConsent(e.target.checked)} />我确认只撤销本次人工新决定</label>
      <button className="btn btn-secondary" disabled={disabled || !undoConsent || draft.conflict} onClick={() => void perform('undo')}>撤销本次人工重新确认</button>
    </> : <>
      {loadError && <p role="alert">读取失败：{loadError}<button className="btn btn-secondary" disabled={disabled} onClick={() => setRetry(n => n + 1)}>重试读取</button></p>}
      <fieldset disabled={disabled} style={{ border: 0, padding: 0, minWidth: 0 }}>
        <legend>1. 选择本作品章节和原文证据（最多99段；结束段落另计）</legend>
        <label>册<select className="input" value={draft.value.volume} onChange={e => change({ volume: e.target.value, chapter: '' })}><option value="">请选择册</option>{volumes.map(v => <option key={v.id} value={v.id}>第{v.volumeNumber}册 {v.title}</option>)}</select></label>
        <label>章<select className="input" value={draft.value.chapter} onChange={e => change({ chapter: e.target.value })}><option value="">请选择章</option>{chapters.map(c => <option key={c.id} value={c.id}>第{c.chapterNumber}章 {c.title}</option>)}</select></label>
        <p>已选 {selected.length} 段，可跨章选择。结束位置也从以下原文中指定，并一同纳入原文预览：该段起不再适用，段落序号是整部作品的位置。</p>
        <button className="btn btn-text" onClick={() => change({ evidence: '[]' })}>清空证据选择</button>
        <div style={{ maxHeight: 360, overflow: 'auto' }}>
          {paragraphs.map(p => <div key={p.id} style={{ paddingBlock: 8, borderBottom: '1px solid var(--border-subtle)' }}>
            <label style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}><input type="checkbox" checked={selected.includes(p.id)} disabled={!selected.includes(p.id) && selected.length >= 99} onChange={e => change({ evidence: JSON.stringify(e.target.checked ? [...selected, p.id] : selected.filter(id => id !== p.id)) })} />§{p.seriesOrdinal}　{p.sourceText}</label>
            <div><button className="btn btn-text btn-sm" onClick={() => change({ end: String(p.seriesOrdinal), endId: p.id, endLabel: `§${p.seriesOrdinal} ${p.sourceText}`, unlimited: false })}>设为有效结束位置</button></div>
          </div>)}
        </div>
        <h4>2. 明确人工新决定</h4>
        <label><input type="checkbox" checked={draft.value.unlimited} onChange={e => change({ unlimited: e.target.checked })} />无限期有效（不设结束位置）</label>
        <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>本次结束位置：{draft.value.unlimited ? '无限期' : draft.value.endLabel || '尚未指定，请在原文段落下选择'}</p>
        <label>人工重新确认理由<textarea className="input" value={draft.value.reason} maxLength={10000} onChange={e => change({ reason: e.target.value })} placeholder="说明所选原文为什么支持本次有效范围。这是新人工判断，不是推测旧状态。" /></label>
        <button className="btn btn-secondary" disabled={!selected.length || !endReady || !draft.value.reason.trim() || draft.conflict || draft.malformed} onClick={() => void perform('preview')}>只读预览，不写入</button>
        {previewReady && <div className="notice">
          <h4>3. 对照预览后确认</h4>
          <p>目标：{kindLabels[preview.result.kind]} — {targetDescription(preview.result, characters)}</p>
          {preview.result.kind === 'character' && <p>人物档案当前状态：{preview.result.target.is_active ? '启用' : '停用'}。设为无限期将启用档案；设置结束位置将按该位置停用。</p>}
          <p>当前范围：{preview.result.kind === 'character' ? '人物档案沿用既有起点' : `从 §${preview.result.target.valid_from_para ?? 0} 起`}，{currentEnd == null ? '无限期' : `到 §${currentEnd} 前结束`}。本次保留起点，改为{draft.value.unlimited ? '无限期有效' : `在 §${draft.value.end} 起不再适用`}。</p>
          {preview.result.evidence.map(e => <p key={e.id} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>原文 §{e.at}：{e.text}</p>)}
          <p style={{ whiteSpace: 'pre-wrap' }}>人工理由：{draft.value.reason}</p>
          <label><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />已核对目标、范围和原文，同意保存本次人工新决定</label>
          <button className="btn btn-primary" disabled={!consent || draft.conflict || draft.malformed} onClick={() => void perform('save')}>保存人工新决定（不自动继续）</button>
        </div>}
      </fieldset>
    </>}
  </section>;
}
