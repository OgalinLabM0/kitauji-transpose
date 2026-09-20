import type { ProjectStore } from '../db';
import { KnowledgeRepo } from '../db/knowledgeRepo';
import { containsVisibleQuote } from '../validation/nameEvidence';

/** Repair a legacy warning using current evidence. Never infer an unknown identity. */
export function repairReviewName(store: ProjectStore, queueId: string): string {
  const item = store.translations.getQueueItem(queueId);
  if (!item || item.kind !== 'warning' || item.status !== 'pending') throw Error('此人物提醒已改变，请刷新后重试');
  const {candidateName,claimedCharacter} = item.payload;
  if (typeof candidateName !== 'string' || typeof claimedCharacter !== 'string' || !item.paragraph_id) throw Error('此提醒没有可核对的人物与原文');
  const para = store.projects.getParagraph(item.paragraph_id);
  if (!para || store.projects.getSeriesIdOfParagraph(para.id)!==item.series_id || !containsVisibleQuote(para.sourceText,candidateName)) throw Error('原文依据已改变，保留提醒，请重新核对');
  const characters = store.knowledge.charactersAt(item.series_id,para.seriesOrdinal);
  const targets = characters.filter(c=>c.canonical_name_jp===claimedCharacter || store.knowledge.aliasesAt(c.id,para.seriesOrdinal).includes(claimedCharacter));
  if (targets.length!==1) throw Error('目标人物不存在或不唯一，无法安全归属；请用中文助手核对，提醒已保留');
  const target=targets[0]!;
  const owners=characters.filter(c=>c.canonical_name_jp===candidateName || store.knowledge.aliasesAt(c.id,para.seriesOrdinal).includes(candidateName));
  if(owners.some(c=>c.id!==target.id))throw Error('这个名字已关联其他人物，不能自动合并；请用中文助手核对，提醒已保留');
  if(owners.length)return `已核对：「${candidateName}」已有正确的人物关联`;
  if(!KnowledgeRepo.isSafeAutoAlias(target.canonical_name_jp,candidateName))throw Error('目前不能从姓名和称谓确定是同一人，未添加或忽略；请用中文助手比较原文依据');
  store.knowledge.addAlias(target.id,candidateName,'pre-read',null,[para.id]);
  store.translations.updateQueuePayload(queueId,{...item.payload,nameRepair:{characterId:target.id,alias:candidateName,created:true,observations:store.db.all('SELECT o.* FROM character_alias_observations o JOIN character_aliases a ON a.id=o.alias_id WHERE a.character_id=? AND a.alias_jp=? ORDER BY o.id',[target.id,candidateName])}});
  for(const p of store.projects.translatedParagraphsContaining(item.series_id,candidateName))store.translations.addRecheck(p.id,'user-decision','人物称谓关联已补全，需要回查');
  return `已补全人物关联：「${candidateName}」属于「${target.canonical_name_jp}」；未改译名或合并档案`;
}

export function undoReviewName(store:ProjectStore,queueId:string):void {
 const item=store.translations.getQueueItem(queueId);const r=item?.payload.nameRepair as {characterId:string;alias:string;created:boolean;observations:unknown[]}|undefined;
 if(!item||item.status!=='resolved'||!r)throw Error('人物处理记录已改变，不能撤销');
 const alias=store.db.get<{alias_type:string}>('SELECT alias_type FROM character_aliases WHERE character_id=? AND alias_jp=?',[r.characterId,r.alias]);
 if(r.created&&alias?.alias_type!=='pre-read')throw Error('此别名已被后续人工修改，不能覆盖');
 if(r.created&&JSON.stringify(r.observations)!==JSON.stringify(store.db.all('SELECT o.* FROM character_alias_observations o JOIN character_aliases a ON a.id=o.alias_id WHERE a.character_id=? AND a.alias_jp=? ORDER BY o.id',[r.characterId,r.alias])))throw Error('人物别名已有新的原文依据，不能覆盖后续记录');
 if(r.created)store.knowledge.removeAlias(r.characterId,r.alias);
 const payload={...item.payload};delete payload.nameRepair;store.translations.updateQueuePayload(queueId,payload);
 store.db.run("UPDATE review_queue SET status='pending',resolution=NULL,resolved_at=NULL WHERE id=?",[queueId]);
 for(const p of store.projects.translatedParagraphsContaining(item.series_id,r.alias))store.translations.addRecheck(p.id,'user-decision','人物关联已撤销，需要回查');
}
