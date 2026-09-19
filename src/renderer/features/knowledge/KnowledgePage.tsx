import { useShallow } from 'zustand/react/shallow';
import { useEffect, useMemo, useRef, useState } from 'react';
import { currentDraftSession } from '../../store/useDraft';
import { useFormDraft } from '../../store/useFormDraft';
import { DraftStatus } from '../../components/DraftStatus';
import { useDraftTarget } from '../../components/DraftRecovery';
import { useApp, tryApi } from '../../store/app';
import { api } from '../../api';
import { Pill, Modal, Switch } from '../../components/ui';
import { UserPlus } from 'lucide-react';
import { CharacterHistory } from './CharacterHistory';
import type { CharacterAutomaticDecisionView, CharacterFieldDecisionView, CharacterView, AddressTrajectoryView, QuirkProfile } from '@shared/types';
import type { RelationshipView, NarrativeEventView } from '@shared/ipc';

const FP = ['boku', 'ore', 'watashi', 'atashi', 'uchi', 'washi', 'sessha', 'watakushi', 'ware', 'oira', 'jibun'];
const REG = ['formal', 'casual', 'rough', 'noble', 'archaic', 'childlike'];

export function KnowledgePage() {
  const { currentSeriesId, rev } = useApp(useShallow(s => ({ currentSeriesId: s.currentSeriesId, rev: s.rev })));
  const [tab, setTab] = useState<'chars' | 'addresses' | 'relations' | 'events'>('chars');
  const [events, setEvents] = useState<NarrativeEventView[]>([]);
  const [chars, setChars] = useState<CharacterView[]>([]);
  const [addrs, setAddrs] = useState<AddressTrajectoryView[]>([]);
  const [rels, setRels] = useState<RelationshipView[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  useDraftTarget('knowledge', target => { if (target === 'new-character') setAdding(true); else if (target === 'new-address' || target.startsWith('end-address:')) setTab('addresses'); else { setTab('chars'); setSel(target); } });
  useEffect(() => { setChars([]); setAddrs([]); setRels([]); setEvents([]); }, [currentSeriesId]);
  useEffect(() => { let active = true; if (currentSeriesId) {
    void api.knowledge.characters(currentSeriesId).then(rows => { if (active) setChars(rows); });
    void api.knowledge.addresses(currentSeriesId).then(rows => { if (active) setAddrs(rows); });
    void api.knowledge.relationships(currentSeriesId).then(rows => { if (active) setRels(rows); });
    void api.knowledge.events(currentSeriesId).then(rows => { if (active) setEvents(rows); });
  } return () => { active = false; }; }, [currentSeriesId, rev.knowledge]);
  const shown = useMemo(() => chars.filter(c => !q || c.nameJp.includes(q) || (c.nameZh ?? '').includes(q)), [chars, q]);
  const cur = chars.find(c => c.id === sel) ?? null;
  if (!currentSeriesId) return <div className="empty"><h2>请先选择系列</h2></div>;
  return (
    <>
      <div className="page-header"><h1>人物与关系</h1><span className="sub small">{chars.length} 人 · {addrs.length} 条称呼轨迹 · {rels.length} 条关系事件 · {events.length} 条剧情事件</span><div className="grow" /><input className="input" style={{ width: 200 }} placeholder="搜索人物…" value={q} onChange={e => setQ(e.target.value)} /><button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}><UserPlus size={13} /> 新增人物</button></div>
      <div className="notice small" style={{ margin: '0 24px 8px' }}>
        <b>全书预读</b>会自动填入：人物信息（日文名、别名、性别、一人称、语域、声音特点）和关系事件流。
        <b>术语确认</b>后会自动填入<b>中文名</b>。
        <b>继续处理本册</b>会检查称呼和语癖：明确的自动使用，不确定的会让你确认。君／酱／桑和人物说话习惯会保留；你也可以随时手动修改。
      </div>
      <div className="tabs" style={{ padding: '0 24px' }}>{(['chars', 'addresses', 'relations', 'events'] as const).map(t => <button key={t} className={`tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>{{ chars: '人物档案', addresses: '称呼轨迹', relations: '关系事件流', events: '剧情时间线' }[t]}</button>)}</div>
      {tab === 'chars' && <div className="three" style={{ gridTemplateColumns: '280px 1fr' }}>
        <div className="col-left">{shown.map(c => <button key={c.id} className={`list-item${sel === c.id ? ' active' : ''}`} onClick={() => setSel(c.id)}><span className="grow ellipsis" style={{ fontFamily: 'var(--font-reading)' }}>{c.nameJp}{c.nameZh ? ` → ${c.nameZh}` : ''}</span>{!c.isActive && <Pill kind="muted">失效</Pill>}{c.lockedByUser && <Pill kind="info">锁</Pill>}</button>)}{shown.length === 0 && <p className="faint small" style={{ padding: 12 }}>{chars.length ? '无匹配' : '运行“预处理 → 全书预读”自动建档，或手动新增'}</p>}</div>
        <div style={{ padding: 24 }}>{cur ? <CharacterDetail key={cur.id} c={cur} seriesId={currentSeriesId} addrs={addrs.filter(a => a.speakerId === cur.id || a.targetId === cur.id)} rels={rels.filter(r => r.fromId === cur.id || r.toId === cur.id)} chars={chars} onMerged={keepId => setSel(keepId)} /> : <p className="faint small">选择一个人物</p>}</div>
      </div>}
      {tab === 'addresses' && <div className="page-body">{addrs.length === 0 && <div className="empty" style={{ padding: '24px 0 8px' }}><p className="muted">称呼轨迹记录谁在什么阶段怎样称呼谁。继续处理本册时会自动检查；不确定方向或阶段的会让你确认，也可以手动添加已知称呼。</p></div>}<AddressTable addrs={addrs} chars={chars} seriesId={currentSeriesId} /></div>}
      {tab === 'relations' && <div className="page-body"><table className="table"><thead><tr><th>从</th><th>→</th><th>到</th><th>事件</th><th>描述</th><th>亲近/尊敬/权距/正式</th><th>起于</th></tr></thead><tbody>{rels.map(r => <tr key={r.id}><td>{r.fromName}</td><td className="faint">→</td><td>{r.toName}</td><td className="small">{r.eventType}</td><td>{r.description}{r.sourceStatus !== 'current' && <div className="hint">历史记录 · {r.sourceStatus === 'superseded' ? '已被重新预读替代' : '依据待重核'}，不用于翻译</div>}</td><td className="small mono">{[r.intimacy, r.respect, r.powerDistance, r.formality].map(v => v ?? '-').join('/')}</td><td className="small faint">#{r.validFromPara}{r.validToPara != null ? `–${r.validToPara}` : ''}</td></tr>)}</tbody></table>{rels.length === 0 && <div className="empty"><p className="muted">全书预读后会在此建立有向关系事件流（A→B 与 B→A 分开）</p></div>}</div>}
      {tab === 'events' && <div className="page-body">
        <p className="small muted" style={{ marginTop: 0 }}>由全书预读建立的剧情时间线。翻译只使用来源仍有效、发生在<b>该段之前</b>的相关事件。「译者知」仅供理解伏笔，不得把读者尚不知的信息写进译文。历史记录保留供查阅，不用于翻译。</p>
        <div className="notice small" style={{ marginBottom: 12, background: 'var(--bg-secondary)', padding: 8, borderRadius: 4 }}>
          预读以日文原文为依据。继续处理本册会自动补齐有效事件和关系的中文摘要；摘要只方便阅读，不替代日文证据。也可在预处理里单独重试中文化。
        </div>
        {events.length === 0 && <div className="empty"><p className="muted">尚无剧情事件。运行「预处理 → 全书预读」后出现。</p></div>}
        <table className="table"><thead><tr><th style={{ width: 110 }}>位置</th><th>事件</th><th>涉及人物</th><th style={{ width: 70 }}>可见性</th></tr></thead><tbody>
          {events.map(e => <tr key={e.id}><td className="small faint">{e.chapterLabel ?? `#${e.atPara}`}</td><td>{e.summary}{e.sourceStatus !== 'current' && <div className="hint">历史记录 · {e.sourceStatus === 'superseded' ? '已被重新预读替代' : '依据待重核'}，不用于翻译</div>}</td><td className="small muted">{e.characterNames.join('、')}</td><td>{e.revealsToReader ? <Pill kind="muted">读者知</Pill> : <Pill kind="warning">译者知</Pill>}</td></tr>)}
        </tbody></table>
      </div>}
      {adding && <CharacterEditor seriesId={currentSeriesId} chars={chars} onClose={() => setAdding(false)} />}
    </>
  );
}

function CharacterDetail({ c, seriesId, addrs, rels, chars, onMerged }: { c: CharacterView; seriesId: string; addrs: AddressTrajectoryView[]; rels: RelationshipView[]; chars: CharacterView[]; onMerged?: (keepId: string) => void }) {
  const currentProfile = { nameZh: c.nameZh ?? '', gender: c.gender ?? '', firstPersonType: c.firstPersonType ?? '', speechRegister: c.speechRegister ?? '', voiceNotes: c.voiceNotes ?? '' };
  const form = useFormDraft(`character-${c.id}`, currentProfile, { page: 'knowledge', seriesId, objectId: c.id, title: `${c.nameJp} · 人物档案` }, { nameJp: c.nameJp, fields: currentProfile, lockedFields: c.lockedFields ?? [] });
  const f = form.value, setF = form.change;
  const running = useApp(s => s.progress.running);
  const [automaticEdits, setAutomaticEdits] = useState<CharacterAutomaticDecisionView[]>([]);
  const [fieldEdits, setFieldEdits] = useState<CharacterFieldDecisionView[]>([]);
  const [undoing, setUndoing] = useState(false);
  const [historyError, setHistoryError] = useState('');
  useEffect(() => { let active = true; setFieldEdits([]); setHistoryError(''); void api.knowledge.fieldDecisions(c.id).then(rows => { if (active) setFieldEdits(rows); }).catch(() => { if (active) setHistoryError('字段记录读取失败，请重新打开人物'); }); return () => { active = false; }; }, [c]);
  const undo = async (decisionId: number) => { setUndoing(true); try { await tryApi(() => api.knowledge.undoFieldDecision(c.id, decisionId), '已撤销字段决定，译稿需按当前知识复核'); const rows = await tryApi(() => api.knowledge.fieldDecisions(c.id)); if (rows) setFieldEdits(rows); } finally { setUndoing(false); } };
  useEffect(() => { let active = true; setAutomaticEdits([]); void api.knowledge.automaticFieldDecisions(c.id).then(rows => { if (active) setAutomaticEdits(rows); }).catch(() => { if (active) setHistoryError('自动决定记录读取失败，请重新打开人物'); }); return () => { active = false; }; }, [c]);
  const undoAutomatic = async (queueId: string) => { setUndoing(true); try { await tryApi(() => api.knowledge.undoAutomaticFieldDecision(c.id,queueId),'自动决定已撤销，候选已恢复待核对，不会立即再次自动采纳'); const rows = await tryApi(() => api.knowledge.automaticFieldDecisions(c.id)); if (rows) setAutomaticEdits(rows); } finally { setUndoing(false); } };
  const fieldText = (value: unknown): string => { if (value == null) return '未知'; if (typeof value === 'object' && 'gender' in value) return String(value.gender ?? '未知'); return String(value); };
  const [aliases, setAliases] = useState<string[]>([]);
  const aliasDraft = useFormDraft(`alias-${c.id}`, { alias: '' }, { page: 'knowledge', seriesId, objectId: c.id, title: `${c.nameJp} · 别名` }, { id: c.id, name: c.nameJp });
  const alias = aliasDraft.value.alias, setAlias = (alias: string) => aliasDraft.change({ alias });
  const quirkDraft = useFormDraft(`quirk-${c.id}`, { trigger: '', pattern: '' }, { page: 'knowledge', seriesId, objectId: c.id, title: `${c.nameJp} · 语癖` }, { id: c.id, name: c.nameJp, quirks: c.quirkProfiles });
  const quirk = quirkDraft.value, setQuirk = quirkDraft.change;
  // Conservative snapshot: a changed source or candidate profile requires comparison.
  const mergeDraft = useFormDraft(`merge-character-${c.id}`, { targetId: '' }, { page: 'knowledge', seriesId, objectId: c.id, title: `${c.nameJp} · 合并目标` }, { source: c, candidates: chars.filter(x => x.id !== c.id).slice().sort((a, b) => a.id.localeCompare(b.id)) });
  const mergeTarget = mergeDraft.value.targetId;
  const setMergeTarget = (targetId: string) => { mergeDraft.change({ targetId }); setMergeConfirm(false); };
  const [mergeConfirm, setMergeConfirm] = useState(false);
  const mergeMounted = useRef(true);
  useEffect(() => { mergeMounted.current = true; return () => { mergeMounted.current = false; }; }, []);
  const closeMerge = () => { if (!mergeDraft.busy) setMergeConfirm(false); };
  const others = chars.filter(x => x.id !== c.id);
  const mergeInto = others.find(x => x.id === mergeTarget);
  useEffect(() => { let active = true; void api.knowledge.aliases(c.id).then(rows => { if (active) setAliases(rows); }); return () => { active = false; }; }, [c]);
  const dirty = f.nameZh !== (c.nameZh ?? '') || f.gender !== (c.gender ?? '') || f.firstPersonType !== (c.firstPersonType ?? '') || f.speechRegister !== (c.speechRegister ?? '') || f.voiceNotes !== (c.voiceNotes ?? '');
  const save = (): Promise<unknown> => {
    const patch = Object.fromEntries(Object.entries(f).filter(([key, value]) => value !== (c[key as keyof typeof f] ?? '')).map(([key, value]) => [key, value || null]));
    return form.save(() => api.knowledge.upsertCharacter(seriesId, { id: c.id, nameJp: c.nameJp, ...patch }), '已保存，修改字段已保护');
  };
  const fieldLabels: Record<string, string> = { gender: '性别', first_person_type: '一人称', speech_register: '语域', voice_notes: '声音说明', plurality: '人数' };
  const quirks = c.quirkProfiles.filter(q => q.quirk_type !== 'rejected');
  const rejected = c.quirkProfiles.filter(q => q.quirk_type === 'rejected');
  const setQuirks = (list: QuirkProfile[]): Promise<unknown> => tryApi(() => api.knowledge.setQuirks(c.id, list));
  return (
    <fieldset disabled={form.busy || aliasDraft.busy || quirkDraft.busy || mergeDraft.busy} style={{ maxWidth: 760, minWidth: 0, border: 0, padding: 0, margin: 0 }}>
      <div className="row wrap" style={{ marginBottom: 12 }}><h2 style={{ margin: 0, fontFamily: 'var(--font-reading)', fontWeight: 500 }}>{c.nameJp}</h2>
        {aliases.map(a => <span key={a} className="alias-pill" title="别名：点「主」设为主名，点 × 删除"><span style={{ fontFamily: 'var(--font-reading)' }}>{a}</span><button className="alias-act" title="设为主名（当前主名降为别名）" onClick={async () => { await tryApi(() => api.knowledge.setCanonicalName(c.id, a), `主名已改为「${a}」`); void api.knowledge.aliases(c.id).then(setAliases); }}>主</button><button className="alias-act" title="删除此别名" onClick={async () => { await tryApi(() => api.knowledge.removeAlias(c.id, a)); void api.knowledge.aliases(c.id).then(setAliases); }}>×</button></span>)}
        <span className="grow" />
        <Switch checked={c.lockedByUser} onChange={v => tryApi(() => api.knowledge.upsertCharacter(seriesId, { id: c.id, nameJp: c.nameJp, lockedByUser: v }))} label="暂停整个人物的自动更新" />
        <Switch checked={c.isActive} onChange={v => tryApi(() => api.knowledge.upsertCharacter(seriesId, { id: c.id, nameJp: c.nameJp, isActive: v }))} label="有效" /></div>
      {!!c.lockedFields?.length && <p className="hint">已确认字段：{c.lockedFields.map(k => fieldLabels[k] ?? k).join('、')}。模型不会覆盖这些决定。</p>}
      <p className="hint">这里修改的人物字段作为全书默认决定保留；只保护实际修改的字段，其他字段仍可随原文更新。阶段性性别决定在复核中处理。</p>
      <CharacterHistory characterId={c.id} />
      {historyError && <p className="hint">{historyError}</p>}
      {!!automaticEdits.length && <details style={{ marginBottom: 12 }}><summary>自动字段决定（最近50条）</summary>
        <p className="hint">这些是经证据确认采纳的阶段观察，不是人工锁定。撤销会恢复旧值并重新打开待确认；已有后续变化时需先处理较新的决定。</p>
        {automaticEdits.map(edit => <div key={edit.id} style={{ marginBlock: 10 }}>
          <div>{fieldLabels[edit.field] ?? edit.field} · 从第 {edit.fromPara} 段起：{fieldText(edit.previous)} → {fieldText(edit.value)}</div>
          <div className="small">{edit.reason}</div>
          <details><summary>查看原文证据</summary>{edit.sources.map(source => <blockquote key={source.id}>第 {source.at} 段：{source.text}</blockquote>)}</details>
          {edit.undone ? <span className="hint">已撤销，等待核对</span> : <button className="btn btn-secondary btn-sm" disabled={!edit.canUndo || undoing || dirty || running} onClick={() => void undoAutomatic(edit.id)}>撤销自动决定</button>}
        </div>)}
      </details>}
      {!!fieldEdits.length && <details style={{ marginBottom: 12 }}><summary>字段决定记录（最近50条）</summary>
        <p className="hint">撤销会恢复该位置原有决定；没有旧决定时使用可用的原文观察。其他字段与后续阶段的决定保留。</p>
        {fieldEdits.map(edit => <div key={edit.id} className="row wrap" style={{ marginBlock: 8, gap: 8 }}>
          <span>{fieldLabels[edit.field] ?? edit.field} · {edit.fromPara === 0 ? '全书默认' : `从第 ${edit.fromPara} 段起`}：{fieldText(edit.previous)} → {fieldText(edit.value)}</span>
          {edit.undone ? <span className="hint">已撤销</span> : <button className="btn btn-secondary btn-sm" disabled={!edit.canUndo || undoing || dirty || running} onClick={() => void undo(edit.id)} title={dirty ? '请先保存或还原未保存的修改' : undefined}>撤销此决定</button>}
        </div>)}
      </details>}
      <div className="settings grid2" style={{ display: 'grid' }}>
        <div className="field"><label>中文名</label><input className="input" value={f.nameZh} onChange={e => setF({ ...f, nameZh: e.target.value })} placeholder="未定：确认术语提案后自动填入，或在此手填" />{!c.nameZh && <span className="hint">预读只建日文档案；中文名在「② 术语提案」里确认人名译名后自动同步到这里。</span>}</div>
        <div className="field"><label>性别 {c.genderConfidence != null && c.genderConfidence < 1 && <span className="faint">（AI 置信度 {c.genderConfidence.toFixed(2)}）</span>}</label><select className="input" value={f.gender} onChange={e => setF({ ...f, gender: e.target.value })}><option value="">未知</option><option value="female">female</option><option value="male">male</option></select></div>
        <div className="field"><label>一人称类型</label><select className="input" value={f.firstPersonType} onChange={e => setF({ ...f, firstPersonType: e.target.value })}><option value="">未知</option>{FP.map(x => <option key={x}>{x}</option>)}</select><span className="hint">影响整体台词语气；首次出现与转变处可加 ruby 罗马音</span></div>
        <div className="field"><label>语域</label><select className="input" value={f.speechRegister} onChange={e => setF({ ...f, speechRegister: e.target.value })}><option value="">未知</option>{REG.map(x => <option key={x}>{x}</option>)}</select></div>
      </div>
      <div className="field"><label>声音备注（性格导致的台词风格）</label><textarea className="input" value={f.voiceNotes} onChange={e => setF({ ...f, voiceNotes: e.target.value })} /></div>
      <DraftStatus draft={form} /><DraftStatus draft={aliasDraft} />
      <div className="row" style={{ marginBottom: 16 }}><button className="btn btn-primary btn-sm" disabled={!dirty || form.busy || form.conflict} onClick={save}>保存档案</button><span className="grow" /><input className="input" style={{ width: 160 }} placeholder="添加别名" value={alias} onChange={e => setAlias(e.target.value)} /><button className="btn btn-secondary btn-sm" disabled={aliasDraft.busy || aliasDraft.conflict || !alias.trim()} onClick={() => aliasDraft.save(() => api.knowledge.addAlias(c.id, alias.trim()), '别名已添加')}>添加</button></div>

      <div className="card"><h3>同一人物合并</h3>
        <p className="faint small" style={{ marginTop: 0 }}>预读会按名字规则自动归并全名/姓/名（如「デグレチャフ」→「ターニャ・デグレチャフ」）。若仍有同一人被建成两个档案，在此把<b>当前人物</b>合并进另一人物：本档案的名字变为对方别名，关系、称呼轨迹、场景分析中的说话人、剧情事件、待处理队列项全部改指对方，然后删除本档案。不可撤销。</p>
        <DraftStatus draft={mergeDraft} />
        {mergeTarget && !mergeInto && <p role="alert">原合并目标已不存在；原选择已保留，请重新选择有效人物并核对。</p>}
        <div className="row"><select aria-label="合并目标" className="input" style={{ maxWidth: 320 }} value={mergeTarget} onChange={e => setMergeTarget(e.target.value)}><option value="">选择要合并进的人物…</option>{mergeTarget && !mergeInto && <option value={mergeTarget}>原目标已不存在（{mergeTarget}）</option>}{others.map(x => <option key={x.id} value={x.id}>{x.nameJp}{x.nameZh ? ` → ${x.nameZh}` : ''}</option>)}</select><button className="btn btn-secondary btn-sm" disabled={!mergeInto || mergeDraft.busy || mergeDraft.conflict || mergeDraft.malformed} onClick={() => setMergeConfirm(true)}>合并到所选</button></div>
        {mergeConfirm && mergeInto && <Modal title="确认合并人物" onClose={closeMerge} footer={<><button className="btn btn-secondary" disabled={mergeDraft.busy} onClick={closeMerge}>取消</button><button className="btn btn-danger" disabled={mergeDraft.busy || mergeDraft.conflict || mergeDraft.malformed} onClick={async () => { const scope = currentDraftSession(); if (!await mergeDraft.save(() => api.knowledge.mergeCharacters(mergeInto.id, c.id), `已把「${c.nameJp}」合并进「${mergeInto.nameJp}」`)) return; if (!mergeMounted.current || scope !== currentDraftSession() || useApp.getState().currentSeriesId !== seriesId) return; setMergeConfirm(false); onMerged?.(mergeInto.id); }}>确认合并</button></>}>
          <DraftStatus draft={mergeDraft} />
          <p>将把 <b style={{ fontFamily: 'var(--font-reading)' }}>{c.nameJp}</b>{c.nameZh ? `（${c.nameZh}）` : ''} 合并进 <b style={{ fontFamily: 'var(--font-reading)' }}>{mergeInto.nameJp}</b>{mergeInto.nameZh ? `（${mergeInto.nameZh}）` : ''}。</p>
          <ul className="small muted"><li>「{c.nameJp}」及其别名 → 成为对方的别名</li><li>对方档案为空的字段（性别/一人称/语域/中文名…）用本档案补齐；语癖取并集</li><li>关系事件、称呼轨迹、场景分析说话人/受话人、剧情事件、待处理列表 → 全部改指对方</li><li>本档案删除</li></ul>
        </Modal>}
      </div>

      <div className="card"><h3>语癖档案</h3>
        {quirks.length === 0 && <p className="faint small">还没有语癖。翻译阶段检测到该人物的口癖（如「のです」「～だぜ」）会让你确认，你确认后在此锁定；也可在下方手动添加。预读不产生语癖。</p>}
        {quirks.map(q => <div key={q.quirk_id} className="row" style={{ padding: '4px 0' }}><span style={{ fontFamily: 'var(--font-reading)' }}>「{q.trigger_form}」→「{q.translation_pattern}」</span>{q.confirmed_by_user ? <Pill kind="success">已锁定</Pill> : q.automatically_adopted ? <Pill kind="success">自动采用</Pill> : <Pill kind="muted">待确认</Pill>}<span className="faint small">自 #{q.locked_at_para}</span><span className="grow" /><button className="btn btn-text btn-sm" onClick={() => setQuirks(c.quirkProfiles.filter(x => x.quirk_id !== q.quirk_id))}>移除</button></div>)}
        {rejected.length > 0 && <div className="small faint" style={{ marginTop: 6 }}>已否定：{rejected.map(q => q.trigger_form).join('、')} <button className="btn btn-text btn-sm" onClick={() => setQuirks(quirks)}>清除否定记录</button></div>}
        <DraftStatus draft={quirkDraft} /><div className="row" style={{ marginTop: 8 }}><input className="input" placeholder="触发形式（正则），如 のです" value={quirk.trigger} onChange={e => setQuirk({ ...quirk, trigger: e.target.value })} /><input className="input" placeholder="译法，如 的说" value={quirk.pattern} onChange={e => setQuirk({ ...quirk, pattern: e.target.value })} /><button className="btn btn-secondary btn-sm" disabled={quirkDraft.busy || quirkDraft.conflict || !quirk.trigger.trim() || !quirk.pattern.trim()} onClick={() => quirkDraft.save(() => api.knowledge.setQuirks(c.id, [...c.quirkProfiles.filter(x => x.trigger_form !== quirk.trigger.trim()), { quirk_id: crypto.randomUUID(), quirk_type: `${quirk.trigger.trim()}型`, trigger_form: quirk.trigger.trim(), translation_pattern: quirk.pattern.trim(), confirmed_by_user: true, locked_at_para: 0, evidence_ids: [] }]), '语癖已保存')}>锁定</button></div></div>

      <div className="card"><h3>称呼轨迹</h3>{addrs.length === 0 ? <p className="faint small">还没有。翻译阶段首次遇到此人对他人（或他人对此人）的称呼时会让你确认，你选定后在此形成轨迹（含起止段落）。翻译前为空是正常的；可在「称呼轨迹」页手动添加。</p> : <AddressTable addrs={addrs} chars={chars} seriesId={seriesId} compact />}</div>
      <div className="card"><h3>关系事件</h3>{rels.length === 0 ? <p className="faint small">尚无。由全书预读建立；若预读已跑但此人无事件，说明文本中未出现明确的关系变化。</p> : rels.map(r => <div key={r.id} className="small" style={{ padding: '3px 0' }}><b>{r.fromName}</b> → <b>{r.toName}</b>：{r.description}{r.sourceStatus !== 'current' && <span className="hint">（历史记录，不用于翻译）</span>} <span className="faint">#{r.validFromPara}</span></div>)}</div>
    </fieldset>
  );
}

function AddressTable({ addrs, chars, seriesId, compact }: { addrs: AddressTrajectoryView[]; chars: CharacterView[]; seriesId: string; compact?: boolean }) {
  const [adding, setAdding] = useState(false);
  const form = useFormDraft('new-address', { speakerId: '', targetId: '', sourceFormJp: '', translatedForm: '', validFromPara: 1 }, { page: 'knowledge', seriesId, objectId: 'new-address', title: '新增有向称呼' }, chars.map(c => ({ id: c.id, name: c.nameJp })));
  const f = form.value, setF = form.change;
  useDraftTarget('knowledge', target => { if (target === 'new-address') setAdding(true); });
  return (
    <>
      <table className="table"><thead><tr><th>说话人</th><th>受话人</th><th>原文形式</th><th>中文</th><th>阶段</th><th>范围</th><th></th></tr></thead><tbody>
        {addrs.map(a => <tr key={a.id}><td>{a.speakerName}</td><td>{a.targetName}</td><td style={{ fontFamily: 'var(--font-reading)' }}>{a.sourceFormJp}</td><td style={{ fontFamily: 'var(--font-reading)' }}><b>{a.translatedForm}</b></td><td className="small muted">{a.relationStage ?? ''}</td><td className="small faint">#{a.validFromPara}{a.validToPara != null ? `–${a.validToPara}` : '–'}</td>
          <td className="row" style={{ gap: 4 }}>{a.confirmedByUser ? <Pill kind="success">锁定</Pill> : a.automaticallyAdopted ? <Pill kind="success">自动采用</Pill> : <Pill kind="muted">待确认</Pill>}<label className="small row" style={{ gap: 4 }}><input type="checkbox" checked={a.allowVariation} onChange={e => tryApi(() => api.knowledge.setAddressVariation(a.id, e.target.checked))} />允许变化</label>{a.validToPara == null && <EndAddressForm address={a} seriesId={seriesId} />}</td></tr>)}
      </tbody></table>
      {!compact && <DraftStatus draft={form} />}
      {!compact && <fieldset disabled={form.busy} style={{ marginTop: 12, minWidth: 0, border: 0, padding: 0 }}>{adding ? <div className="row wrap"><select className="input" style={{ width: 160 }} value={f.speakerId} onChange={e => setF({ ...f, speakerId: e.target.value })}><option value="">说话人</option>{chars.map(c => <option key={c.id} value={c.id}>{c.nameZh ?? c.nameJp}</option>)}</select><select className="input" style={{ width: 160 }} value={f.targetId} onChange={e => setF({ ...f, targetId: e.target.value })}><option value="">受话人</option>{chars.map(c => <option key={c.id} value={c.id}>{c.nameZh ?? c.nameJp}</option>)}</select><input className="input" style={{ width: 160 }} placeholder="原文形式 ターニャちゃん" value={f.sourceFormJp} onChange={e => setF({ ...f, sourceFormJp: e.target.value })} /><input className="input" style={{ width: 120 }} placeholder="中文" value={f.translatedForm} onChange={e => setF({ ...f, translatedForm: e.target.value })} /><input className="input" style={{ width: 90 }} type="number" min={1} value={f.validFromPara} onChange={e => setF({ ...f, validFromPara: Number(e.target.value) })} title="起始段落序号" /><button className="btn btn-primary btn-sm" disabled={form.busy || form.conflict || !f.speakerId || !f.targetId || !f.sourceFormJp || !f.translatedForm} onClick={async () => { if (await form.save(() => api.knowledge.addAddress(seriesId, f), '已添加')) setAdding(false); }}>添加</button><button className="btn btn-text btn-sm" onClick={() => setAdding(false)}>取消</button></div> : <button className="btn btn-secondary btn-sm" onClick={() => setAdding(true)}>手动添加称呼</button>}</fieldset>}
    </>
  );
}

function EndAddressForm({ address: a, seriesId }: { address: AddressTrajectoryView; seriesId: string }) {
  const [open, setOpen] = useState(false);
  const form = useFormDraft(`end-address-${a.id}`, { at: '' }, { page: 'knowledge', seriesId, objectId: `end-address:${a.id}`, title: `${a.speakerName} → ${a.targetName} · 结束称呼` }, a);
  useDraftTarget('knowledge', target => { if (target === `end-address:${a.id}`) setOpen(true); });
  if (!open) return <button className="btn btn-text btn-sm" onClick={() => setOpen(true)}>结束{form.stored ? '（有草稿）' : ''}</button>;
  return <div><DraftStatus draft={form} /><div className="row wrap"><input className="input" style={{ width: 90 }} type="number" min={a.validFromPara + 1} placeholder="止于段#" disabled={form.busy} value={form.value.at} onChange={e => form.change({ at: e.target.value })} onKeyDown={e => { if (e.key === 'Escape' && !form.busy) setOpen(false); }} />
    <button className="btn btn-primary btn-sm" disabled={form.busy || form.conflict || !form.value.at || Number(form.value.at) <= a.validFromPara} onClick={async () => { if (await form.save(() => api.knowledge.endAddress(a.id, Number(form.value.at)), '已结束此称呼')) setOpen(false); }}>确定</button>
    <button className="btn btn-text btn-sm" disabled={form.busy} onClick={() => setOpen(false)}>收起并保留</button></div></div>;
}

function CharacterEditor({ seriesId, chars, onClose }: { seriesId: string; chars: CharacterView[]; onClose: () => void }) {
  const form = useFormDraft('new-character', { nameJp: '', nameZh: '', gender: '', firstPersonType: '' }, { page: 'knowledge', seriesId, objectId: 'new-character', title: '新增人物' }, chars.map(c => ({ id: c.id, nameJp: c.nameJp, nameZh: c.nameZh, gender: c.gender, firstPersonType: c.firstPersonType })));
  const f = form.value, setF = form.change;
  const close = () => { if (!form.busy) onClose(); };
  return <Modal title="新增人物" onClose={close} footer={<><button className="btn btn-secondary" disabled={form.busy} onClick={close}>关闭并保留输入</button><button className="btn btn-primary" disabled={form.busy || form.conflict || !f.nameJp.trim()} onClick={async () => { if (await form.save(() => api.knowledge.upsertCharacter(seriesId, { nameJp: f.nameJp.trim(), nameZh: f.nameZh || null, gender: f.gender || null, firstPersonType: f.firstPersonType || null, lockedByUser: true }), '已添加')) onClose(); }}>添加</button></>}>
    <DraftStatus draft={form} /><fieldset disabled={form.busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
    <div className="field"><label>日文名</label><input className="input" value={f.nameJp} onChange={e => setF({ ...f, nameJp: e.target.value })} autoFocus /></div>
    <div className="field"><label>中文名</label><input className="input" value={f.nameZh} onChange={e => setF({ ...f, nameZh: e.target.value })} /></div>
    <div className="row"><div className="field grow"><label>性别</label><select className="input" value={f.gender} onChange={e => setF({ ...f, gender: e.target.value })}><option value="">未知</option><option value="female">female</option><option value="male">male</option></select></div><div className="field grow"><label>一人称</label><select className="input" value={f.firstPersonType} onChange={e => setF({ ...f, firstPersonType: e.target.value })}><option value="">未知</option>{FP.map(x => <option key={x}>{x}</option>)}</select></div></div>
  </fieldset></Modal>;
}
