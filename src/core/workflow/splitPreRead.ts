import { KnowledgeRepo } from '../db/knowledgeRepo';
import type { ProjectStore } from '../db';
import { validNameQuote } from '../validation/nameEvidence';
import { parseNameMentionReview } from '../validation/nameMentionReview';
import {readNameMentionReceipt,saveNameMentionReceipt} from './nameMentionReceipts';
import { parsePreRead, type PreReadOutput, type ProtocolResult, type AiClient } from '@core/ai';
import { preReadOutputSchema, type PreReadParagraph } from '@core/ai/protocol';

export function parsePreReadPart(raw: string, task: 'characters' | 'events', paragraphs: readonly PreReadParagraph[], names: readonly string[], nameBoundaryReview?: (name:string,paragraphId:string,quote:string)=>boolean): ProtocolResult<PreReadOutput> {
  try {
    const value = JSON.parse(raw);
    const fields = task === 'characters' ? ['characters'] : ['relationship_events', 'plot_events', 'knowledge_change_candidates'];
    if (!value || !Array.isArray(value.reviewed_ids) || fields.some(key => !Array.isArray(value[key]))) throw new Error('预读分工响应缺少完整回执或候选数组');
    if (task === 'characters' && value.characters.some((c: { name_jp?: unknown } | null) => c && typeof c.name_jp === 'string' && /^(unknown|不明|名無し|私|わたし|僕|ぼく|俺|おれ|彼|彼女)$/i.test(c.name_jp.trim()))) {
      throw new Error('匿名说话人和代词不能作为人物姓名。只返回原文有明确姓名的人物；本次没有实名人物时返回 {"reviewed_ids":[本次全部段落ID],"characters":[]}，不要用 unknown 或“私”填一条人物记录');
    }
    // Optional entity bindings are not the event itself. Keep the evidence and
    // narrative facts even when the name-registration station has no entry yet.
    // Never create a character or guess an identity to satisfy a binding field.
    if (task === 'events') {
      const shape = preReadOutputSchema.safeParse({ characters: [], reviewed_ids: value.reviewed_ids, relationship_events: value.relationship_events, plot_events: value.plot_events, knowledge_change_candidates: value.knowledge_change_candidates });
      if (!shape.success) return { ok: false, error: { code: 'INVALID_SHAPE', message: shape.error.message } };
      value.plot_events = shape.data.plot_events;
      value.relationship_events = shape.data.relationship_events;
      const allowed = new Set(names);
      for (const event of value.plot_events) {
        if (event && Array.isArray(event.character_names) && event.character_names.every((n: unknown) => typeof n === 'string')) event.character_names = event.character_names.filter((n: string) => allowed.has(n));
      }
      const relations = [];
      for (const event of value.relationship_events) {
        if (event && typeof event.from_name_jp === 'string' && typeof event.to_name_jp === 'string' && event.from_name_jp !== event.to_name_jp && (!allowed.has(event.from_name_jp) || !allowed.has(event.to_name_jp))) {
          // The standard parser below still validates evidence IDs, ordinal and
          // nonempty description. Unbound relations stay facts, not graph edges.
          if (!Array.isArray(event.evidence_ids) || typeof event.description_jp !== 'string' || !event.description_jp.trim() || ![event.from_name_jp,event.to_name_jp].every(name => allowed.has(name) || paragraphs.some(p => event.evidence_ids.includes(p.id) && p.sourceText.includes(name)))) { relations.push(event); continue; }
          value.plot_events.push({ summary_jp: `${event.from_name_jp} → ${event.to_name_jp}：${event.description_jp}`, at_para: event.at_para, evidence_ids: event.evidence_ids, reveals_to_reader: true, character_names: [event.from_name_jp,event.to_name_jp].filter(n => allowed.has(n)) });
        } else relations.push(event);
      }
      value.relationship_events = relations;
    }
    // Other duties cannot write through this workstation, even if a weak model returns them.
    const selected = Object.fromEntries(fields.map(key => [key, value[key]]));
    const result = parsePreRead(JSON.stringify({ characters: [], relationship_events: [], plot_events: [], knowledge_change_candidates: [], reviewed_ids: value.reviewed_ids, ...selected }), paragraphs, names, nameBoundaryReview);
    return result;
  } catch (error) { return { ok: false, error: { code: 'INVALID_SHAPE', message: (error as Error).message } }; }
}

export async function splitPreRead(ai: AiClient, user: string, batch: readonly PreReadParagraph[], knownNames: string[], check: () => void, signal?: AbortSignal, onStage?: (label: string) => void, store?: ProjectStore): Promise<PreReadOutput> {
  // Let the caller shrink a failed multi-paragraph input before identical retries
  // consume the consecutive-failure guard. Single paragraphs retain bounded repair.
  const options = { parseRetries: batch.length > 1 ? 0 : 2, paragraphId: batch[0]!.id, ...(signal ? { signal } : {}) };
  onStage?.('人物预读');
  const people = await ai.structured({ ...options, workstation: 'book-pre-reader', user }, raw => parsePreReadPart(raw, 'characters', batch, knownNames,store?()=>true:undefined));
  check();
  if(store){
    const ambiguous:{character:PreReadOutput['characters'][number];paragraphId:string;source:string}[]=[];
    for(const c of people.value.characters){
      const needsSemanticReview=KnowledgeRepo.isGenericName(c.name_jp);
      if(knownNames.includes(c.name_jp)&&!needsSemanticReview)continue;
      const e=c.name_evidence;
      if(!needsSemanticReview && e && validNameQuote(c.name_jp,e.quote,batch.find(p=>p.id===e.paragraph_id)?.sourceText??''))continue;
      if(!needsSemanticReview && !e && batch.some(p=>c.evidence_ids.includes(p.id)&&validNameQuote(c.name_jp,p.sourceText,p.sourceText)))continue;
      const p=e?batch.find(p=>p.id===e.paragraph_id):batch.find(p=>c.evidence_ids.includes(p.id)&&p.sourceText.includes(c.name_jp));
      if(!p)throw Error(`人物「${c.name_jp}」缺少本次姓名原文，未建立人物。`);
      ambiguous.push({character:c,paragraphId:p.id,source:p.sourceText});
    }
    const pending=ambiguous.filter(a=>!readNameMentionReceipt(store,a.paragraphId,a.character.name_jp));
    if(pending.length){
      onStage?.('核对原文中的人物称呼');
      const candidates=pending.map((a,i)=>({id:'name-'+i,name:a.character.name_jp,source:a.source}));
      const review=await ai.structured({workstation:'character-evidence-reviewer',nameMentionReview:true,user:JSON.stringify({paragraphs:candidates}),paragraphId:pending[0]!.paragraphId,parseRetries:1,...(signal?{signal}:{})},raw=>parseNameMentionReview(raw,candidates));
      check();
      store.transaction(()=>{for(const item of review.value){const index=candidates.findIndex(c=>c.id===item.id);const a=pending[index]!;saveNameMentionReceipt(store,a.paragraphId,a.character.name_jp,item,review.aiCallId);}});
    }
    const rejected=new Set<PreReadOutput['characters'][number]>();
    for(const a of ambiguous){
      const receipt=readNameMentionReceipt(store,a.paragraphId,a.character.name_jp);
      if(!receipt)throw Error('姓名核对依据已失效，请重新准备。');
      if(receipt.decision==='uncertain')throw Error(`人物称呼「${a.character.name_jp}」的原文含义尚不明确，已保留核对记录。若确为人名，请在人物页新增这个原文名字后继续；不确定时请保留现场反馈，重复继续不会重新收费核对。`);
      if(receipt.decision==='not_person'){rejected.add(a.character);continue;}
      a.character.name_evidence??={paragraph_id:a.paragraphId,quote:receipt.quote};
    }
    people.value.characters=people.value.characters.filter(c=>!rejected.has(c));
    const approved=parsePreReadPart(JSON.stringify({reviewed_ids:people.value.reviewed_ids,characters:people.value.characters}),'characters',batch,knownNames,(name,id)=>readNameMentionReceipt(store,id,name)?.decision==='person');
    if(!approved.ok)throw Error(approved.error.message);
    people.value=approved.value;
    for(const c of people.value.characters){if(c.name_evidence){const r=readNameMentionReceipt(store,c.name_evidence.paragraph_id,c.name_jp);if(r?.decision==='person')Object.assign(c.name_evidence,{reviewId:r.id});}}
  }
  const names = [...new Set([...knownNames, ...people.value.characters.map(c => c.name_jp)])];
  const input = JSON.parse(user);
  // Only names cross the boundary; no guessed gender, voice or quirk proposal anchors events.
  onStage?.('事件与关系预读');
  const events = await ai.structured({ ...options, workstation: 'event-pre-reader', user: JSON.stringify({ ...input, known_names: names }) }, raw => parsePreReadPart(raw, 'events', batch, names));
  check();
  return { ...events.value, characters: people.value.characters };
}
