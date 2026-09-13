import { useEffect, useState } from 'react';
import { api } from '../../api';
import { useApp } from '../../store/app';
import type { CharacterKnowledgeHistory, KnowledgeEvidenceView, KnowledgeSourceStatus } from '@shared/types';

const labels: Record<KnowledgeSourceStatus, string> = { manual: '人工决定', current: '原文有效 · 按阶段使用', stale: '依据已变化 · 不用于翻译', unverified: '旧记录缺少依据 · 不用于翻译', superseded: '已被新观察替代 · 不用于翻译' };
const fields: Record<string, string> = { gender: '性别', first_person_type: '一人称', speech_register: '语域', voice_notes: '声音说明', plurality: '人数' };
function Evidence({ rows }: { rows: KnowledgeEvidenceView[] }) {
  if (!rows.length) return null;
  return <details><summary>查看依据当前原文（最多8段）</summary><p className="hint">这是书库中的当前原文；标为失效的观察不能用这些文字重新认证。</p>{rows.map(row => <blockquote key={row.id} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', marginInline: 12 }}>第 {row.at ?? '已删除'} 段：{row.currentText ?? '原文已不存在'}</blockquote>)}</details>;
}
export function CharacterHistory({ characterId }: { characterId: string }) {
  const revision = useApp(s => s.rev.knowledge);
  const [data, setData] = useState<CharacterKnowledgeHistory | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true; setData(null); setError('');
    void api.knowledge.history(characterId).then(value => { if (active) setData(value); }).catch(() => { if (active) setError('记录读取失败，请重新打开人物档案'); });
    return () => { active = false; };
  }, [characterId, revision]);
  return <section className="card character-history" style={{ overflowWrap: 'anywhere', minWidth: 0 }}>
    <h3>姓名、别名与字段依据</h3>
    <p className="hint">原文变化后的旧观察保留在这里，但不再指导翻译。继续处理本册可重新预读；人工决定会保留。档案编辑区显示当前有效字段，译文会按各段的剧情位置选择。</p>
    {error ? <p role="alert">{error}</p> : !data ? <p className="hint">正在读取记录…</p> : <>
      <h4>主名使用状态</h4>
      {!data.names?.length && <p className="hint">旧档案未记录主名来源，暂沿用原有设置，不能据此视为已核验。</p>}
      {data.names?.map(name => <div key={name.id} style={{ marginBlock: 12 }}><b>{name.name}</b> · <span>{labels[name.sourceStatus]}</span>{name.fromPara != null && <div className="hint">从第 {name.fromPara} 段起</div>}<Evidence rows={name.evidence} /></div>)}
      <h4>别名使用状态</h4>
      {data.aliases.length === 0 && <p className="hint">尚无别名记录。</p>}
      {data.aliases.map(alias => <div key={alias.id} style={{ marginBlock: 12 }}><b>{alias.name}</b> · <span>{labels[alias.sourceStatus]}</span><div className="hint">{alias.fromPara == null ? '未设置起点' : `从第 ${alias.fromPara} 段起`}{alias.toPara == null ? '' : `，到第 ${alias.toPara} 段前`}</div><Evidence rows={alias.evidence} /></div>)}
      <details><summary>字段观察与历史（{data.fieldTotal}条，显示最近100条）</summary>
        {data.fields.length === 0 && <p className="hint">没有带时间记录的字段。旧档案中的静态值未补造原文依据。</p>}
        {data.fields.map(field => <div key={field.id} style={{ marginBlock: 16 }}><b>{fields[field.field] ?? field.field}：{field.value}</b><div className="hint">从第 {field.fromPara} 段起 · {labels[field.sourceStatus]}</div>{field.quotes.length > 0 && <details><summary>观察当时保存的引文</summary>{field.quotes.map((quote, i) => <blockquote key={i} style={{ whiteSpace: 'pre-wrap', marginInline: 12 }}>{quote}</blockquote>)}</details>}<Evidence rows={field.evidence} /></div>)}
      </details>
    </>}
  </section>;
}
