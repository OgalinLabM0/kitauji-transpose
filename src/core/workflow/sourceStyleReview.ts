import type {AiClient} from '../ai';
import type {ProjectStore} from '../db';
import type {NaturalnessAssessment} from './naturalness';
import {auditInput} from './auditReceipts';
import {naturalnessEvidenceKey,NATURALNESS_CONTRACT} from './naturalnessEvidence';
import {NATURALNESS_SHORT_LIMIT} from './longNaturalnessPlan';
import {parseDispute} from './disputeReview';
import {SOURCE_STYLE_PROMPT} from '../validation/sourceStyleEvidence';
const attempted=new WeakMap<AbortSignal,Set<string>>();

/** Reconsider a reading allegation using the source; grants no fidelity/voice receipt. */
export async function reviewSourceStyle(store:ProjectStore,ai:AiClient,id:string,draft:string,reading:NaturalnessAssessment,signal?:AbortSignal):Promise<boolean>{
 const p=store.projects.getParagraph(id);
 if(!p||reading.decision!=='edit'||reading.issues.length!==1||p.sourceText.length+draft.length>NATURALNESS_SHORT_LIMIT)return false;
 const raw=store.archives.blocksOfParagraph(id)[0]?.inline_template;
 if(raw&&JSON.parse(raw).markers.some((m:{kind:string})=>m.kind==='atomic'))return false;
 const visible=(s:string)=>s.replace(/⟦\/?\d+⟧/gu,'');
 const issue={quote_zh:visible(reading.issues[0]!.quote_zh),reason:reading.issues[0]!.reason};
 if(!issue.quote_zh||!visible(draft).includes(issue.quote_zh))return false;
 const {inputHash,pack}=auditInput(store,id);
 const context=(pack.sourceContextIds??[]).map(pid=>store.projects.getParagraph(pid)).filter(p=>p!=null).map(p=>({id:p.id,source:visible(p.sourceText)}));
 const key=JSON.stringify([id,inputHash,draft,issue,SOURCE_STYLE_PROMPT]);
 if(signal){const seen=attempted.get(signal)??new Set<string>();if(seen.has(key))return false;seen.add(key);attempted.set(signal,seen);}
 const r=await ai.structured({workstation:'naturalness-reviewer',sourceStyle:true,paragraphId:id,user:JSON.stringify({source:visible(p.sourceText),translation:visible(draft),issue,context}),parseRetries:1,maxOutputTokens:1400,...(signal?{signal}:{})},text=>parseDispute(text,visible(p.sourceText),visible(draft)));
 signal?.throwIfAborted();
 if(auditInput(store,id).inputHash!==inputHash||store.projects.getParagraph(id)?.sourceText!==p.sourceText)throw Error('表达争议复核期间依据已变化');
 store.translations.log({level:'info',workstationId:'naturalness-reviewer',paragraphId:id,message:JSON.stringify({kind:'source-style-review',aiCallId:r.aiCallId,verdict:r.value})});
 if(r.value.decision!=='retain')return false;
 // Explicit normalization of a real source-aware retain verdict, not a fabricated
 // blind-review keep. Readers validate this separate proof and exact call stage.
 const proof={contract:NATURALNESS_CONTRACT,decision:'keep',assessment:{id,decision:'keep',issues:[]},aiCallId:r.aiCallId,sourceStyle:{contract:SOURCE_STYLE_PROMPT,source:p.sourceText,draft,issue,verdict:r.value}};
 store.db.run('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)',[naturalnessEvidenceKey(id,inputHash,draft),JSON.stringify(proof)]);
 return true;
}
