import type {ProviderConfig} from './providers/adapter';
export const TRANSLATION_THINKING_POLICY = 'flash-staged-v1' as const;
const reasoningStages = new Set(['faithful-translator','chinese-editor','fidelity-reviewer','address-reviewer','naturalness-reviewer','dispute-reviewer','repair-resolution-reviewer','restructuring-reviewer']);
function supportedOfficialEndpoint(provider:ProviderConfig):boolean{
 if(provider.protocol!=='chat-completions')return false;
 try{const url=new URL(provider.baseUrl);return url.protocol==='https:'&&url.hostname==='api.deepseek.com'&&(!url.port||url.port==='443')&&!url.username&&!url.password&&!url.search&&!url.hash&&/^(?:\/v1)?\/?$/.test(url.pathname);}catch{return false;}
}
/** Provider identity and manuscript remain unchanged; only validated stages reason. */
export function translationThinking(provider:ProviderConfig,call:{workstation:string;inlineStage?:string;maxOutputTokens?:number},policy?:typeof TRANSLATION_THINKING_POLICY):{provider:ProviderConfig;maxOutputTokens:number|undefined}{
 const enabled=policy===TRANSLATION_THINKING_POLICY&&provider.model==='deepseek-flash'&&supportedOfficialEndpoint(provider)&&reasoningStages.has(call.workstation)&&(!call.inlineStage||call.inlineStage==='body');
 if(!enabled)return {provider,maxOutputTokens:call.maxOutputTokens};
 return {provider:{...provider,thinkingMode:'enabled',reasoningEffort:'high'},maxOutputTokens:Math.max(8192,call.maxOutputTokens??provider.maxOutputTokens)};
}
