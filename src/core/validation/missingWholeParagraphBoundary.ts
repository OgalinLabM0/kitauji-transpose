import type {InlineTemplate} from '../epub/blocks';

/** Restore an unambiguous whole-paragraph wrapper, never a ruby, anchor, or
 * interior emphasis boundary. All visible characters remain exactly as sent. */
export function restoreMissingWholeParagraphBoundary(source:string,draft:string,template:InlineTemplate):string {
 if(template.markers.length!==1)return draft;
 const marker=template.markers[0]!;
 if(marker.kind!=='wrap')return draft;
 const open=`⟦${marker.id}⟧`,close=`⟦/${marker.id}⟧`;
 if(!source.startsWith(open)||!source.endsWith(close)||/[⟦⟧]/u.test(source.slice(open.length,-close.length)))return draft;
 const tokens=draft.match(/⟦\/?\d+⟧/gu)??[];
 if(tokens.some(t=>t!==open&&t!==close)||tokens.filter(t=>t===open).length>1||tokens.filter(t=>t===close).length>1)return draft;
 if(tokens.length===2&&(tokens[0]!==open||tokens[1]!==close))return draft;
 const plain=draft.replace(/⟦\/?\d+⟧/gu,'');
 if(!plain.trim()||/[⟦⟧]/u.test(plain))return draft;
 return open+plain+close;
}
