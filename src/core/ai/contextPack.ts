import {scopedRegisters} from './registerContext';
import {hasContextHeader,meaningfulContextWindow} from './contextWindow';
import {originalRubyContext} from '../workflow/originalRubyContext';
import {reviewedQuirkExamples} from './quirkExamples';
import {scopedQuirkRules} from './quirkContext';
import { scopedBaseVoices } from './voiceContext';
import { honorificPolicy } from './prompts/honorificPolicy';
import { possibleNameQuote } from './possibleNameMentions';
import { staleAutomaticSources } from '@core/workflow/automaticKnowledgeSources';
import { paragraphLiteralAddressPairs } from '@core/workflow/paragraphLiteralAddresses';
import { auditStatus } from '@core/workflow/auditReceipts';
import { localVoiceObservations } from '@core/workflow/fieldObservationDismissal';
import { withIdentityRead } from '../db/identitySources';
/**
 * 九层上下文包 L0–L8（docs/设计/PLAN_历史架构.md 第 6 节）。L0 在 systemPrompts；本文件组装 L1–L8 为 user 消息前缀。
 * 检索原则：实体 → 关系方向 → 剧情时间 → 场景 → 术语，先过滤再限量；未确认候选不进入确定性部分。
 */
import type { ProjectStore, CharacterRow, AddressRow } from '@core/db';
import { fromJson } from '@core/db';
import { findGlossaryHits, type GlossaryHitDetail } from '@core/glossary/hits';
import type { WorkstationId } from '@shared/types';

export interface ContextPackInput {
  paragraphIds: string[];           // 本次批处理的段落（同一场景内连续）
  workstation: WorkstationId;
  windowBefore?: number;            // L6 前文段数
  windowAfter?: number;             // L6 后文段数（只给原文）
  sourceOnlyWindow?: boolean;       // 审校依赖原文窗口，避免同批新译稿改变审校依据
  visibleBody?: boolean;            // 仅正文生成视图，保留全部知识约束
}
export interface ContextPack {
  sourceContextIds?: string[];      // 实际发送的只读原文窗口，供场景结果绑定来源
  text: string;                     // 拼好的 L1–L8 文本
  glossaryHits: GlossaryHitDetail[];
  presentCharacterIds: string[];
  atPara: number;
  seriesId: string;
}

const j = (v: unknown): string => JSON.stringify(v, null, 0);

export function buildContextPack(store: ProjectStore, input: ContextPackInput): ContextPack {
  // Context assembly only reads source, knowledge and audit receipts. Share
  // transitive proof checks within this synchronous read, then release them;
  // every later context build still validates current sources and user edits.
  return withIdentityRead(store.db, () => {
  const first = store.projects.getParagraph(input.paragraphIds[0]!);
  if (!first) throw new Error('段落不存在');
  const seriesId = store.projects.getSeriesIdOfParagraph(first.id);
  if (staleAutomaticSources(store, seriesId).length) throw new Error('自动知识依据已变化，请继续处理本册以重新核对；不能沿用旧决定翻译');
  const series = store.db.get<{ title: string; author: string | null; volumeNumber: number }>('SELECT se.title, se.author, v.volume_number AS volumeNumber FROM chapters c JOIN volumes v ON v.id=c.volume_id JOIN series se ON se.id=v.series_id WHERE c.id=?', [first.chapterId])!;
  const settings = store.projects.getSettings(seriesId);
  const paras = input.paragraphIds.map(id => store.projects.getParagraph(id)!).filter(Boolean);
  const atPara = paras[0]!.seriesOrdinal;
  const lastPara = paras[paras.length - 1]!.seriesOrdinal;
  const texts = paras.map(p => p.sourceText);

  // ---- L1 作品圣经 + 命中术语 ----
  const terms = store.glossary.activeTerms(seriesId, atPara);
  const glossaryHits = findGlossaryHits(terms.map(t => ({ id: t.id, term_jp: t.term_jp, term_zh: t.term_zh, term_type: t.term_type, lock_level: t.lock_level, sense_identity: t.sense_identity, senses: t.senses })), texts);
  const l1 = [
    `【L1 作品圣经】`,
    `系列：${series.title}${series.author ? `（${series.author}）` : ''}；当前册：${series.volumeNumber}`,
    `称谓默认风格：${settings['honorific.default_style'] === 'loan' ? '借用式（桑/酱/君/大人）' : '按人物关系与场景译成中文'}；一人称 ruby 标注：${settings['ruby.first_person'] ? '开启（在 flags first-person-shift 中报告转变即可，标注由程序生成）' : '关闭'}`,
    honorificPolicy(settings['honorific.default_style']),
    glossaryHits.length
      ? `本段命中术语（默认义 = 优先译法；lock=hard-locked 无条件使用；lock=confirmed 仅在语境属其他义项时可偏离并必须声明 glossary-deviation；lock=suggested 仅供参考）：\n${glossaryHits.map(h => `- ${h.termJp} → ${h.termZh ?? '（未定）'} [${h.termType}, lock=${h.lockLevel}${h.senseIdentity ? `, 义=${h.senseIdentity}` : ''}]${h.senseDetails.filter(s => !s.isDefault).length ? ` 其他已确认义项：${h.senseDetails.filter(s => !s.isDefault).map(s => `${s.zh}${s.gloss ? `(${s.gloss})` : ''}${s.hint ? ` 判别:${s.hint}` : ''}`).join('；')}` : ''}`).join('\n')}`
      : '本段未命中术语表条目。',
  ].join('\n');

  // ---- 场景人物：来自场景分析；无分析时回退为原文出现的人物名 ----
  const analyses = store.projects.analysesFor(input.paragraphIds);
  // Scene identity and difficulty flags share the same source provenance as atmosphere.
  // Old rows remain stored for inspection, but cannot instruct a changed paragraph.
  for (const id of analyses.keys()) if (!store.projects.sceneObservation(id)) analyses.delete(id);
  const allChars = store.knowledge.charactersAt(seriesId, atPara).map(c => store.knowledge.characterAt(c, atPara)).filter(c => c.is_active || (c.deactivated_at_para ?? Infinity) > atPara);
  const presentIds = new Set<string>();
  for (const a of analyses.values()) {
    if (a.speaker_char_id) presentIds.add(a.speaker_char_id);
    for (const id of fromJson<string[]>(a.target_char_ids, [])) presentIds.add(id);
    for (const id of fromJson<string[]>(a.present_char_ids, [])) presentIds.add(id);
  }
  const joinedSrc = texts.join('\n');
  // 在场判定按场景窗口（前后文）而非仅当前段：说话人常在相邻段落才被点名
  const beforeCount=input.windowBefore ?? (input.sourceOnlyWindow ? 6 : 3),afterCount=input.windowAfter ?? 2;
  // Bounded extra look-back prevents usernames/post numbers from consuming the
  // whole language context. Keep every intervening header and its source ID.
  const initialBefore=store.projects.previousParagraphs(first.id,beforeCount),lastId=paras[paras.length-1]!.id;
  const initialAfter=store.projects.nextParagraphs(lastId,afterCount);
  const before = hasContextHeader(initialBefore)?meaningfulContextWindow(store.projects.previousParagraphs(first.id,beforeCount+12),beforeCount,'before'):initialBefore;
  const after = hasContextHeader(initialAfter)?meaningfulContextWindow(store.projects.nextParagraphs(lastId,afterCount+12),afterCount,'after'):initialAfter;
  if (input.sourceOnlyWindow) for (const p of before) p.finalText = null;
  const previousChapter = before.length < (input.windowBefore ?? (input.sourceOnlyWindow ? 6 : 3)) ? store.projects.previousChapterSource(first.id) : [];
  const sceneSrc = [...previousChapter.map(p => p.sourceText), ...before.map(b => b.sourceText), joinedSrc, ...after.map(a => a.sourceText)].join('\n');
  for (const c of allChars) {
    if (presentIds.has(c.id)) continue;
    const names = [c.canonical_name_jp, ...store.knowledge.aliasesAt(c.id, atPara)].filter(n => n.length >= 2);
    if (names.some(n => sceneSrc.includes(n))) presentIds.add(c.id);
  }
  const present = allChars.filter(c => presentIds.has(c.id));
  const presentList = present.map(c => c.id);
  // Single-character names can also be ordinary words. Retrieve names separately;
  // never let lexical candidates select voice, relationships or scene participants.
  const nameWindows = [
    ...previousChapter.map(p => ({...p, location:'前章'})),
    ...before.map(p => ({...p, location:'前文'})),
    ...paras.map(p => ({...p, location:'当前'})),
    ...after.map(p => ({...p, location:'后文'})),
  ];
  const possibleNames = allChars.filter(c => !presentIds.has(c.id)).flatMap(c => {
    const names = [c.canonical_name_jp, ...store.knowledge.aliasesAt(c.id, atPara)];
    return names.flatMap(name => {
      const matches = nameWindows.flatMap(p => {
        const quote = possibleNameQuote(p.sourceText, name);
        return quote ? [{paragraph_id:p.id, location:p.location, quote}] : [];
      });
      return matches.length ? [{name_jp:name, canonical_name_jp:c.canonical_name_jp, name_zh:c.canonical_name_zh, mentions:matches.slice(0, 3)}] : [];
    });
  });
  const possibleNameContext = possibleNames.length ? `【可能对应的单字姓名】\n${j(possibleNames)}\n同字也可能是普通词，须结合原文判断；这里只提供已有姓名写法，不证明在场、说话人、性别或关系。前后文不能补入当前译文。` : '';
  const relevantAliases = (id: string) => store.knowledge.aliasesAt(id, atPara).filter(alias => sceneSrc.includes(alias));
  const scopedQuirks=scopedQuirkRules(store,seriesId,paras,id=>analyses.get(id)?.speaker_char_id);
  const quirkRules=scopedQuirks.length ? `【本次目标段的已采用语癖】\n${scopedQuirks.map(s=>`- 仅段落 ${s.paragraphIds.join('、')} ${s.name}：当前已采用语癖：${s.quirk.trigger_form}→${s.quirk.translation_pattern}`).join('\n')}\n规则及例句只适用于所列段落的该人物发言；不推广到其他段落、未知说话人、旁人或叙述。` : '';
  const quirkExamples = scopedQuirks.flatMap(s => {
    const q=s.quirk,prefix=`仅段落 ${s.paragraphIds.join('、')} ${s.name}`;
    const reviewed=reviewedQuirkExamples(store,s.characterId,q,s.paragraphIds);
    if(reviewed.length)return reviewed.map(e=>`${prefix} 的已审语癖例句（日文原文→中文示例）：${e.source}→${e.translation}。仅示范该人物的表达，不把例句事实补进当前正文。`);
    if(q.example_review_queue_id)return [];
    const example = q.trigger_form.includes('にゃ') && q.translation_pattern.includes('喵')
      ? '「行くにゃ」→“去喵”；「待つにゃ」→“等着喵”。'
      : q.trigger_form === 'のです' && q.translation_pattern.includes('的说')
        ? '「うれしいのです」→“好开心的说”。普通礼貌体不照搬此语癖。' : '';
    return example ? [`${prefix} 的本段语癖示例：${example}只供落实该角色原文明示的语气，不照抄例句内容。`] : [];
  });

  // ---- L2 时间线 ----
  const events = store.knowledge.eventsBefore(seriesId, atPara, 8, presentList);
  const l2 = `【L2 剧情时间线（截至此刻，reader=false 表示读者尚未知晓，仅用于理解，不得在译文中泄露）】\n${events.length ? events.map(e => `- @${e.at_para} ${e.summary_jp}${e.reveals_to_reader ? '' : ' [reader=false]'}`).join('\n') : '（尚无预读记录）'}`;

  const baseVoices=scopedBaseVoices(store,present,paras,id=>analyses.get(id)?.speaker_char_id);
  // ---- L3 人物档案 ----
  const states = store.knowledge.statesAt(presentList, atPara);
  const l3 = `【L3 在场/相关人物（仅列相关别名；口吻只用于所属人物发言）】\n${present.length ? present.map(c => describeCharacter(c, relevantAliases(c.id), states.filter(s => s.character_id === c.id))).join('\n') : '（本段未识别到已建档人物）'}`;

  const registers=scopedRegisters(store,seriesId,paras,id=>analyses.get(id)?.speaker_char_id);
  const registerText=registers.length?`【仅对应人物发言的语域参考】\n${registers.map(r=>`- 仅段落 ${r.paragraphId} ${r.name}：语域=${r.value}（${r.origin==='user'?'用户明确设置的有效阶段':'仅本处原文的模型观察，不是长期规则'}）`).join('\n')}\n每条只用于所列段落和说话人；原文当句的礼貌、粗鲁、角色扮演与反差优先，不按语域标签统一改写，不推广到其他段落、旁人、未知说话人或叙述。`:'';

  // ---- L4 有向关系 ----
  const rels = store.knowledge.relationshipsAt(seriesId, presentList, atPara);
  const nameOf = (id: string): string => { const c = allChars.find(x => x.id === id); return c ? (c.canonical_name_zh ?? c.canonical_name_jp) : id; };
  const l4 = `【L4 有向关系（A→B 与 B→A 分开；数值 0–10）】\n${rels.length ? rels.map(r => `- ${nameOf(r.from_char_id)}→${nameOf(r.to_char_id)}：${r.description_jp}${fmtLevels(r)}`).join('\n') : '（无记录）'}`;

  // ---- 称呼轨迹（L4 附） ----
  // Keep only adopted forms actually relevant to this target block. A character can
  // have hundreds of unrelated directional addresses; none should become instructions here.
  const addrs = store.knowledge.addressesFor(seriesId, presentList, atPara)
    .filter(a => store.knowledge.isAddressAdopted(a) && paras.some(p => {
      if (!p.sourceText.includes(a.source_form_jp)) return false;
      const speaker = analyses.get(p.id)?.speaker_char_id;
      return !speaker || speaker === a.speaker_char_id;
    }))
    .map(a => ({ ...a, automatically_adopted: !a.confirmed_by_user }));
  const l4b = addrs.length ? `【已确认称呼轨迹（同一说话人→受话人在当前关系阶段跨章、跨册沿用；换章不重置。仅原文称呼改变、关系变化或明确场景用意支持时提出变化；allow_variation=1也不允许随意换称呼）】\n${addrs.map(a => fmtAddress(a, nameOf)).join('\n')}` : '';

  // ---- L5 场景状态 ----
  const l5 = `【L5 当前场景】\n${paras.map(p => { const a = analyses.get(p.id); const scene = store.projects.sceneObservation(p.id); return `- ${p.id}：${scene ? `原文场景观察：${scene.boundary ? '此处转场；' : ''}${scene.atmosphere}（仅帮助理解，不得加入译文）；` : ''}${p.paragraphType}${a ? `；说话人=${a.speaker_char_id ? nameOf(a.speaker_char_id) : 'unknown'}(${a.speaker_confidence ?? '?'})；受话人=${fromJson<string[]>(a.target_char_ids, []).map(nameOf).join('/') || 'unknown'}；意图=${a.intent ?? 'unknown'}` : '；（未做场景分析）'}`; }).join('\n')}`;

  // ---- L6 局部窗口 ----
  const l6 = `【L6 局部窗口】\n前文（日文是依据；中文仅作连续性参考，不能作为本段事实来源）：\n${before.length ? before.map(b => { const final = b.finalText ? store.translations.latestFinal(b.id) : undefined; const verified = final && auditStatus(store, final) === 'valid'; return `JP: ${b.sourceText}${verified ? `\nZH（忠实审校有效，仍须服从当前原文）: ${b.finalText}` : ''}`; }).join('\n') : '（场景开头）'}\n后文原文（仅供理解指代，不得提前翻译或泄露）：\n${after.length ? after.map(a => `JP: ${a.sourceText}`).join('\n') : '（场景结尾）'}`;

  const chapterReference = previousChapter.length ? `【相邻前章原文，仅供核对指代】\n章界不代表同一场景，不据此认定人物仍在场；同一人物关系当前有效的已确认称呼仍跨章沿用，不把别人的称呼照搬过来。只翻译本次目标，不补入这些内容。\n${previousChapter.map(p => `@${p.seriesOrdinal} ${p.id}: ${p.sourceText}`).join('\n')}` : '';

  // ---- L7 已知难点 ----
  const l7Items: string[] = [];
  for (const p of paras) {
    const a = analyses.get(p.id);
    const flags = fromJson<string[]>(a?.difficulty_flags, []);
    if (flags.length) l7Items.push(`- ${p.id}：场景分析标记 ${flags.join(', ')}`);
    // 术语出现记录里的歧义/偏离历史
    for (const h of glossaryHits) if (p.sourceText.includes(h.termJp) && h.senseDetails.length > 1) l7Items.push(`- ${p.id}：「${h.termJp}」在本系列有多个义项，请判断本处义项并在 flags 输出 glossary-sense 或 glossary-deviation`);
  }
  const wordplay = store.translations.confirmedWordplay(seriesId).filter(w => joinedSrc.includes(w.source_variant) || joinedSrc.includes(w.source_original));
  for (const w of wordplay) l7Items.push(`- 已决定的谐音/双关：「${w.source_variant}」（原音「${w.source_original}」=${w.source_meaning}）→ 「${w.final_zh}」，同类处理保持一致`);
  for (const s of scopedQuirks) l7Items.push(`- 仅段落 ${s.paragraphIds.join('、')} ${s.name} 的「${s.quirk.trigger_form}」${s.quirk.confirmed_by_user ? "已锁定为语癖" : "证据化自动采用语癖（服从原文）"} → 「${s.quirk.translation_pattern}」，只在所列人物发言中保持一致（一致性原则）`);
  const l7 = `【L7 本段已知难点（必须逐项处理并在 flags 中回应）】\n${l7Items.length ? l7Items.join('\n') : '（无）'}`;

  // ---- L8 用户锁定 ----
  const hard = glossaryHits.filter(h => h.lockLevel === 'hard-locked');
  const lockedChars = present.filter(c => c.locked_by_user);
  const lockedAddrs = addrs.filter(a => a.confirmed_by_user);
  const l8Items = [
    ...hard.map(h => `- 术语硬锁定：「${h.termJp}」→「${h.termZh}」无条件使用`),
    ...lockedChars.map(c => `- 人物锁定：${c.canonical_name_jp}→${c.canonical_name_zh ?? '（未定）'}，性别=${c.gender ?? 'unknown'}，一人称=${c.first_person_type ?? 'unknown'}`),
    ...lockedAddrs.map(a => `- 称呼锁定：${nameOf(a.speaker_char_id)} 称 ${nameOf(a.target_char_id)} 的「${a.source_form_jp}」→「${a.translated_form}」${a.allow_variation ? '（允许场景变化）' : ''}`),
  ];
  const l8 = `【L8 用户锁定决定（最高优先级）】\n${l8Items.length ? l8Items.join('\n') : '（无）'}`;

  const localForms=paras.flatMap(p=>paragraphLiteralAddressPairs(store,p.id));
  const literalNames=localForms.length ? `【仅本段字面称呼形式】\n${localForms.map(p=>`- ${p.paragraphId}：「${p.source}」→「${p.target}」`).join('\n')}\n只约定这些原文形式的中文写法，不证明说话人、受话人或关系；私下／公开等条件仍须忠实翻译，不向其他段落推广。` : '';
  const localVoices=[...new Map([...baseVoices.local,...localVoiceObservations(store,input.paragraphIds)].map(v=>[JSON.stringify([v.paragraphId,v.characterId,v.note]),v])).values()];
  const userVoiceText=baseVoices.userNotes.length ? `【用户确认声音：按本次目标段的有效阶段】\n${baseVoices.userNotes.map(v=>`- ${v.paragraphId} ${v.name}：声音：${v.note}`).join('\n')}\n每条只用于所列段落中该人物的发言；长期确认按各段位置取值，不把其他阶段声音带入本段，不用于旁人或叙述。` : '';
  const localVoiceText=localVoices.length ? `【仅对应原句的声音观察】\n${localVoices.map(v=>`- ${v.paragraphId} ${v.name}：${v.note}`).join('\n')}\n只辅助对应人物原句的表达；服从原文，不推广到其他段落，不补进叙事或覆盖已确认语癖。` : '';
  const originalRuby=input.visibleBody?'':paras.map(p=>originalRubyContext(store,p.id)).filter(Boolean).join('\n');
  const text = [l1, l2, l3, registerText, userVoiceText, localVoiceText, quirkRules, quirkExamples.join('\n'), possibleNameContext, l4, l4b, literalNames, l5, l6, chapterReference, l7, l8, originalRuby].filter(Boolean).join('\n\n') + `\n\n【剧情位置】series_ordinal ${atPara}–${lastPara}`;
  return { text:input.visibleBody?text.replace(/⟦\/?\d+⟧/gu,''):text, sourceContextIds: [...before, ...after, ...previousChapter].map(p => p.id), glossaryHits, presentCharacterIds: presentList, atPara, seriesId };
  });
}

function describeCharacter(c: CharacterRow, aliases: string[], states: { state_type: string; description: string; is_translator_only: number }[]): string {
  const parts = [
    `- ${c.canonical_name_jp}${c.canonical_name_zh ? `→${c.canonical_name_zh}` : ''}${aliases.length ? `（别名：${aliases.join('、')}）` : ''}`,
    `性别=${c.gender ?? 'unknown'}${c.gender_confidence != null ? `(${c.gender_confidence})` : ''}，人数=${c.plurality ?? 'unknown'}，一人称=${c.first_person_type ?? 'unknown'}`,
    states.length ? `此刻状态：${states.map(s => `${s.description}${s.is_translator_only ? '[译者知]' : ''}`).join('；')}` : '',
    c.locked_by_user ? '[用户锁定]' : '',
  ].filter(Boolean);
  return parts.join('；');
}
const fmtLevels = (r: { intimacy_level: number | null; respect_level: number | null; power_distance: number | null; formality_level: number | null }): string => {
  const p: string[] = [];
  if (r.intimacy_level != null) p.push(`亲近${r.intimacy_level}`); if (r.respect_level != null) p.push(`尊敬${r.respect_level}`);
  if (r.power_distance != null) p.push(`权力距${r.power_distance}`); if (r.formality_level != null) p.push(`正式${r.formality_level}`);
  return p.length ? `（${p.join(' ')}）` : '';
};
const fmtAddress = (a: AddressRow, nameOf: (id: string) => string): string =>
  `- ${nameOf(a.speaker_char_id)}→${nameOf(a.target_char_id)}：「${a.source_form_jp}」→「${a.translated_form}」${a.relation_stage ? ` [${a.relation_stage}]` : ''}${a.allow_variation ? ' allow_variation=1' : ''}${a.confirmed_by_user ? '' : a.automatically_adopted ? ' (证据化自动采用，服从原文)' : ' (候选)'}`;

export { j as jsonCompact };

