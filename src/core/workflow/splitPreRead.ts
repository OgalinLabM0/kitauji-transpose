import { parsePreRead, type PreReadOutput, type ProtocolResult, type AiClient } from '@core/ai';
import type { PreReadParagraph } from '@core/ai/protocol';

export function parsePreReadPart(raw: string, task: 'characters' | 'events', paragraphs: readonly PreReadParagraph[], names: readonly string[]): ProtocolResult<PreReadOutput> {
  try {
    const value = JSON.parse(raw);
    const fields = task === 'characters' ? ['characters'] : ['relationship_events', 'plot_events', 'knowledge_change_candidates'];
    if (!value || !Array.isArray(value.reviewed_ids) || fields.some(key => !Array.isArray(value[key]))) throw new Error('预读分工响应缺少完整回执或候选数组');
    if (task === 'characters' && value.characters.some((c: { name_jp?: unknown } | null) => c && typeof c.name_jp === 'string' && /^(unknown|不明|名無し|私|わたし|僕|ぼく|俺|おれ|彼|彼女)$/i.test(c.name_jp.trim()))) {
      throw new Error('匿名说话人和代词不能作为人物姓名。只返回原文有明确姓名的人物；本次没有实名人物时返回 {"reviewed_ids":[本次全部段落ID],"characters":[]}，不要用 unknown 或“私”填一条人物记录');
    }
    // Other duties cannot write through this workstation, even if a weak model returns them.
    const selected = Object.fromEntries(fields.map(key => [key, value[key]]));
    const result = parsePreRead(JSON.stringify({ characters: [], relationship_events: [], plot_events: [], knowledge_change_candidates: [], reviewed_ids: value.reviewed_ids, ...selected }), paragraphs, names);
    if (task === 'events' && !result.ok && result.error.message.includes('事件涉及未建档人物')) {
      return { ok: false, error: { ...result.error, message: '本步骤不能补人物档案。人物绑定字段只使用 known_names 中的姓名；尚未建档者不填入 character_names（可以为[]），原文明示的信息仍保留在 summary_jp。关系两端无法绑定时，用事件摘要保留事实，不编造人物ID或姓名。' } };
    }
    return result;
  } catch (error) { return { ok: false, error: { code: 'INVALID_SHAPE', message: (error as Error).message } }; }
}

export async function splitPreRead(ai: AiClient, user: string, batch: readonly PreReadParagraph[], knownNames: string[], check: () => void, signal?: AbortSignal): Promise<PreReadOutput> {
  const options = { paragraphId: batch[0]!.id, ...(signal ? { signal } : {}) };
  const people = await ai.structured({ ...options, workstation: 'book-pre-reader', user }, raw => parsePreReadPart(raw, 'characters', batch, knownNames));
  check();
  const names = [...new Set([...knownNames, ...people.value.characters.map(c => c.name_jp)])];
  const input = JSON.parse(user);
  // Only names cross the boundary; no guessed gender, voice or quirk proposal anchors events.
  const events = await ai.structured({ ...options, workstation: 'event-pre-reader', user: JSON.stringify({ ...input, known_names: names }) }, raw => parsePreReadPart(raw, 'events', batch, names));
  check();
  return { ...events.value, characters: people.value.characters };
}
