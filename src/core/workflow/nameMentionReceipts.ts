import {createHash,randomUUID} from 'node:crypto';
import type {ProjectStore,Db} from '../db';
import {NAME_MENTION_REVIEW_PROMPT,parseNameMentionReview,type NameMentionDecision} from '../validation/nameMentionReview';
const version=createHash('sha256').update(NAME_MENTION_REVIEW_PROMPT).digest('hex');
interface Receipt {id:string;paragraphId:string;name:string;source:string;version:string;aiCallId:string;decision:NameMentionDecision['decision'];quote:string}
const key=(paragraphId:string,name:string)=>'name-mention-review:'+createHash('sha256').update(JSON.stringify([paragraphId,name,version])).digest('hex');
function validCall(db:Db,id:string){const c=db.get<{error:string|null;finish_reason:string|null;workstation_id:string|null}>('SELECT error,finish_reason,workstation_id FROM ai_calls WHERE id=?',[id]);return !!c&&!c.error&&c.finish_reason==='stop'&&c.workstation_id==='character-evidence-reviewer';}
/** Internal persistence only; model output must never provide a receipt ID or call ID. */
export function saveNameMentionReceipt(store:ProjectStore,paragraphId:string,name:string,item:NameMentionDecision,aiCallId:string):string {
 return store.transaction(()=>{
  const p=store.projects.getParagraph(paragraphId);if(!p||!validCall(store.db,aiCallId))throw Error('姓名核对缺少当前原文或成功核对调用');
  const checked=parseNameMentionReview(JSON.stringify({items:[item]}),[{id:item.id,name,source:p.sourceText}]);if(!checked.ok)throw Error(checked.error.message);
  const receipt:Receipt={id:randomUUID(),paragraphId,name,source:p.sourceText,version,aiCallId,decision:item.decision,quote:item.quote};
  store.db.run('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',[key(paragraphId,name),JSON.stringify(receipt)]);
  return receipt.id;
 });
}
export function readNameMentionReceipt(store:ProjectStore,paragraphId:string,name:string):Receipt|null { return readNameMentionReceiptDb(store.db,paragraphId,name); }
export function readNameMentionReceiptDb(db:Db,paragraphId:string,name:string):Receipt|null {
 try{const row=db.get<{value:string}>('SELECT value FROM meta WHERE key=?',[key(paragraphId,name)]);if(!row)return null;const r=JSON.parse(row.value) as Receipt;
  const p=db.get<{source_text:string}>('SELECT source_text FROM paragraphs WHERE id=?',[paragraphId]);if(!p||r.paragraphId!==paragraphId||r.name!==name||r.source!==p.source_text||r.version!==version||!validCall(db,r.aiCallId))return null;
  const valid=parseNameMentionReview(JSON.stringify({items:[{id:r.id,decision:r.decision,quote:r.quote}]}),[{id:r.id,name,source:p.source_text}]);return valid.ok?r:null;
 }catch{return null;}
}
export function hasVerifiedNameMention(store:ProjectStore,paragraphId:string,name:string,receiptId:string):boolean {
 const r=readNameMentionReceipt(store,paragraphId,name);return !!r&&r.id===receiptId&&r.decision==='person';
}

export function hasVerifiedNameMentionDb(db:Db,paragraphId:string,name:string,receiptId:unknown):boolean { const r=readNameMentionReceiptDb(db,paragraphId,name);return typeof receiptId==='string'&&!!r&&r.id===receiptId&&r.decision==='person'; }
