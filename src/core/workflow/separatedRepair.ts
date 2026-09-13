import type {ProjectStore} from '../db';
import type {AiClient} from '../ai';
import {buildContextPack} from '../ai';
import type {InlineTemplate} from '../epub/blocks';
import {generationConstraints} from '../ai/prompts/generationConstraints';
import {naturalnessText} from './naturalnessText';
import {originalRubyEntries} from './originalRuby';
import {separatedGeneration,separatedGenerationIdentity} from './separatedGeneration';

export const SEPARATED_REPAIR_CONTRACT='repair-visible-body-original-ruby-recovery-v2';
export function separatedRepairTemplate(store:ProjectStore,id:string):InlineTemplate|null {
 const p=store.projects.getParagraph(id),raw=store.archives.blocksOfParagraph(id)[0]?.inline_template;
 if(!p||p.sourceText.length>1200||!raw)return null;
 const template:InlineTemplate=JSON.parse(raw);
 return template.markers.some(m=>m.kind==='ruby')&&!template.markers.some(m=>m.kind==='atomic')?template:null;
}
export const separatedRepairIdentity=()=>JSON.stringify([SEPARATED_REPAIR_CONTRACT,separatedGenerationIdentity()]);

/** Old drafts carry no authority over the original ruby attachment. Generate
 * visible prose, then attach layout without permitting a second rewrite. */
export async function generateSeparatedRepair(a:{store:ProjectStore;ai:AiClient;id:string;source:string;draft:string;template:InlineTemplate;issues:unknown;relations:string;signal:AbortSignal;check:()=>Promise<void>;workstation?:'faithful-translator'|'chinese-editor'}) {
 const workstation=a.workstation??'faithful-translator';
 const pack=buildContextPack(a.store,{paragraphIds:[a.id],workstation,visibleBody:true});
 const user=(pack.text+'\n【定点修复】对照日文核实issues，只修确实存在的问题，其余表达保持。旧稿不是原作注音归属的依据；本步只返回连续正文，版式随后单独处理。\n'+JSON.stringify({issues:a.issues,items:[{id:a.id,source:naturalnessText(a.source,a.template).text,draft:naturalnessText(a.draft,a.template).text,source_constraints:generationConstraints(a.source)}]})+a.relations+'\n【原作注音含义，仅供理解】'+JSON.stringify(originalRubyEntries(a.source,a.template).map(({sourceBase,rt})=>({sourceBase,reading:rt})))).replace(/⟦\/?\d+⟧/gu,'');
 return separatedGeneration({store:a.store,ai:a.ai,id:a.id,source:a.source,template:a.template,user,resume:true,signal:a.signal,check:a.check,workstation});
}
