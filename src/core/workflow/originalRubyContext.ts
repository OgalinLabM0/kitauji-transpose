import type {ProjectStore} from '@core/db';
import type {InlineTemplate} from '../epub/blocks';
import {originalRubyEntries,ORIGINAL_RUBY_CONTRACT} from './originalRuby';

/** Source metadata only. A draft mapping is a hypothesis, never an approval. */
export function originalRubyContext(store:ProjectStore,id:string,draft?:string):string {
 const source=store.projects.getParagraph(id)?.sourceText;
 if(source===undefined)throw new Error('原注音段落不存在');
 const raw=store.archives.blocksOfParagraph(id)[0]?.inline_template;
 const template:InlineTemplate=raw?JSON.parse(raw):{markers:[]};
 if(!template.markers.some(m=>m.kind==='ruby'))return '';
 const entries=originalRubyEntries(source,template);
 let mapped=entries,unavailable=false;
 if(draft!==undefined){try{mapped=originalRubyEntries(source,template,draft);}catch{unavailable=true;}}
 return `【原作注音对应 ${ORIGINAL_RUBY_CONTRACT}】\n${JSON.stringify({paragraphId:id,original_ruby:mapped,...(unavailable?{draft_mapping:'当前稿标记不完整，不能确定注音附着对象'}:{})})}\n仅适用于所列段落。sourceBase是原作注音正文，rt是其原始注层；保持ruby标记包住对应词义的中文，不能转移到邻近其他词。既有targetBase仅说明当前附着位置，可能有错，须依据原文修正。保留普通读音与特殊读法、双关的差别；不要删除或擅改注层，也不要求中文发音等于日文。局部或长段任务只处理当前source实际包含的标记，其余不是输出范围。`;
}
