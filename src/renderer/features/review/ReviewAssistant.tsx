import { useEffect, useRef, useState } from 'react';
import type { ReviewAssistantConversation } from '@shared/reviewAssistant';
import { api } from '../../api';
import { currentDraftSession } from '../../store/useDraft';

export function ReviewAssistant({id,onEnglish}:{id:string;onEnglish?:((english:string,gloss:string)=>void)|undefined}){
 const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[question,setQuestion]=useState('');
 const [conversation,setConversation]=useState<ReviewAssistantConversation|null>(null);
 const live=useRef(true);const pending=useRef(false);
 useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
 async function ask(text?:string){
  if(pending.current)return;pending.current=true;setBusy(true);setError('');const token=currentDraftSession();
  try{
   let result=text?null:await api.review.assistant(id);
   if(!live.current||token!==currentDraftSession())return;
   if(!result)result=await api.review.assistant(id,text??'请用中文解释这一项及全部背景，比较候选并给出建议；如涉及英文，请核对原形与中文ruby。');
   if(live.current&&token===currentDraftSession()){setConversation(result);setQuestion('');}
  }catch(e){if(live.current&&token===currentDraftSession())setError(e instanceof Error?e.message:String(e));}
  finally{pending.current=false;if(live.current)setBusy(false);}
 }
 return <><button className="btn btn-secondary" onClick={()=>{setOpen(true);if(!conversation&&!busy)void ask();}}>用中文帮我分析 / 追问</button>
 {open&&<aside className="review-assistant" role="dialog" aria-label="待确认助手"><header><strong>待确认助手</strong><button className="btn btn-text" onClick={()=>setOpen(false)}>收起</button></header>
 <p className="small muted">只分析当前条目。中文解释供理解，最终选择由你确认。</p>
 <div className="assistant-transcript">{conversation?.turns.map((turn,i)=><section key={i}><p className="assistant-question">{turn.question}</p><div className="assistant-answer">{turn.reply.answer}</div>
 {turn.reply.evidence.map(e=><div className="assistant-evidence" key={e.id}><p>{e.zh}</p><details><summary>对照日文原句</summary><p lang="ja">{e.source}</p></details></div>)}
 {onEnglish&&turn.reply.english&&turn.reply.gloss&&<div className="assistant-suggestion"><ruby>{turn.reply.english}<rt>{turn.reply.gloss}</rt></ruby><button className="btn btn-secondary" disabled={busy} onClick={()=>{onEnglish(turn.reply.english!,turn.reply.gloss!);setOpen(false);}}>填入表单，待我确认</button></div>}
 </section>)}{busy&&<p role="status">正在结合原文分析…可以收起窗口，完成后再查看。</p>}{error&&<p role="alert">{error}</p>}</div>
 <form onSubmit={e=>{e.preventDefault();if(question.trim())void ask(question);}}><textarea aria-label="向助手追问" maxLength={1500} value={question} onChange={e=>setQuestion(e.target.value)} placeholder="例如：这里为什么不是人名？这个英文拼写有什么依据？"/><div className="row"><button className="btn btn-primary" disabled={busy||!question.trim()}>发送</button>{busy&&<button type="button" className="btn btn-secondary" onClick={()=>void api.workflow.cancel().catch(()=>{})}>停止分析</button>}{!busy&&error&&<button type="button" className="btn btn-secondary" onClick={()=>void ask()}>重试分析</button>}</div></form>
 </aside>}</>;
}
