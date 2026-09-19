import { useShallow } from 'zustand/react/shallow';
import { useEffect, useState } from 'react';
import type { ParagraphView } from '@shared/types';
import type { Api } from '@shared/ipc';
import { api } from '../../api';
import { useApp, tryApi } from '../../store/app';
import { MarkedText } from '../../components/ui';
type Context = Awaited<ReturnType<Api['translation']['context']>>;
export function ReviewEvidence({ paragraphId }: { paragraphId: string | null }) {
  const { jumpToParagraph, rev, currentVolumeId } = useApp(useShallow(s => ({ jumpToParagraph: s.jumpToParagraph, rev: s.rev, currentVolumeId: s.currentVolumeId })));
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ paragraph: ParagraphView; context: Context } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true; setData(null); setError('');
    if (!open || !paragraphId) return;
    void Promise.all([api.project.getParagraph(paragraphId), api.translation.context(paragraphId)])
      .then(([paragraph, context]) => { if (active) { if (paragraph) setData({ paragraph, context }); else setError('原段落已不存在'); } })
      .catch(e => { if (active) setError((e as Error).message); });
    return () => { active = false; };
  }, [paragraphId, open, rev.paragraphs, rev.knowledge, rev.glossary, rev.settings]);
  if (!paragraphId) return <p className="small muted">系列共享知识：该记录没有绑定单一段落。</p>;
  return <div className="review-evidence">
    <div className="row"><button className="btn btn-text btn-sm" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? '收起当前原译与前后文' : '查看当前原译与前后文'}</button><button className="btn btn-secondary btn-sm" onClick={() => void tryApi(() => jumpToParagraph(paragraphId))}>到正文处理</button></div>
    {open && (!data ? <p>{error || '正在读取当前稿件…'}</p> : <>
      <p className="small muted">当前保存的第 {data.paragraph.seriesOrdinal} 段{data.paragraph.volumeId !== currentVolumeId ? ' · 来自其他册的关联证据' : ''}。下方问题记录可能引用较早版本。</p>
      {data.context.before.map(p => <div key={p.id} className="evidence-neighbor"><span>前文（日文）</span><MarkedText text={p.source} />{p.final && <><span>前文（中文）</span><MarkedText text={p.final} /></>}</div>)}
      <div className="evidence-pair"><div><strong>当前日文</strong><MarkedText text={data.paragraph.sourceText} /></div><div><strong>当前译稿</strong>{data.paragraph.final ? <MarkedText text={data.paragraph.final.text} /> : <p>尚无译稿</p>}</div></div>
      {data.context.after.map(p => <div key={p.id} className="evidence-neighbor"><span>后文（日文）</span><MarkedText text={p.source} /></div>)}
    </>)}
  </div>;
}
