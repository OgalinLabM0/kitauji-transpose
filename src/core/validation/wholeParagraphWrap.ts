import {validateMarkers,type InlineTemplate} from '../epub/blocks';

/** Restore only known wrappers covering every character of the source paragraph.
 * This preserves presentation, never certifies or changes the visible draft. */
export function restoreWholeParagraphWrap(source:string,draft:string,template:InlineTemplate):string|null {
  if(!draft.trim() || /[⟦⟧]/u.test(draft) || !template.markers.length || template.markers.some(m=>m.kind!=='wrap'))return null;
  if(new Set(template.markers.map(m=>m.id)).size!==template.markers.length || !validateMarkers(source,template).ok)return null;
  const match=/^((?:⟦\d+⟧)+)([^⟦⟧]+)((?:⟦\/\d+⟧)+)$/u.exec(source);
  if(!match || !match[2]!.trim() || [...match[1]!.matchAll(/⟦\d+⟧/gu)].length!==template.markers.length)return null;
  const restored=match[1]+draft+match[3];
  return validateMarkers(restored,template).ok?restored:null;
}
