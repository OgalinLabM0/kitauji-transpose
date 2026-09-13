/** 一人称 ruby 使用当前日文原形；首次及形式转变标注，不能改写中文正文。 */
import { planFirstPersonRuby } from './firstPersonRuby';
import type { TranslationItem } from '@core/ai/protocol';
import type { RubyAnnotation } from '@core/db';
import type { TranslationFlag, ProjectSettings } from '@shared/types';
import { stripMarkers } from '@core/epub/blocks';


/** Relocate unchanged annotated words after manual edits; never reuse an old numeric offset blindly. */
export function relocateRubyAnnotations(before: string, after: string, marks: readonly RubyAnnotation[]): RubyAnnotation[] {
  const old = stripMarkers(before), next = stripMarkers(after);
  let prefix = 0;
  while (prefix < old.length && prefix < next.length && old[prefix] === next[prefix]) prefix++;
  let suffix = 0;
  while (suffix < old.length - prefix && suffix < next.length - prefix && old[old.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
  return marks.flatMap(mark => {
    const token = old.slice(mark.start, mark.end);
    if (!token || mark.start < 0 || mark.end > old.length) return [];
    let start: number;
    if (mark.end <= prefix) start = mark.start;
    else if (mark.start >= old.length - suffix) start = mark.start + next.length - old.length;
    else { start = next.indexOf(token); if (start < 0 || next.indexOf(token, start + 1) >= 0) return []; }
    return next.slice(start, start + token.length) === token ? [{ ...mark, start, end: start + token.length }] : [];
  });
}

export interface RubyInput {
  source: string;                            // 当前原文，一人称标注不能只依赖人物常用口吻
  translation: string;                       // 含标记
  flags: readonly TranslationFlag[];
  settings: ProjectSettings;
  speakerFirstPerson: string | null;         // 当前说话人档案里的人称类型
  /** 该说话人此前是否已经加过一人称 ruby */
  speakerAlreadyAnnotated: boolean;
  isDialogue: boolean;
  properNouns?: { zh: string; rt: string }[];
  coverage?: TranslationItem['source_coverage'];
  previousForm?: string | null;
}

/** 检查位置是否在标点符号或空白字符上 */
function isPunctuationOrWhitespace(char: string): boolean {
  // 中文标点、英文标点、日文标点、空白
  return /[\s\p{P}\p{S}]/u.test(char);
}

/** 安全查找词语位置：确保不在标点内，且是完整词语边界 */
function safeFindWord(text: string, word: string, startFrom: number = 0): number {
  let pos = startFrom;
  while (true) {
    const idx = text.indexOf(word, pos);
    if (idx < 0) return -1;

    // 检查前后字符，确保是完整词语边界
    const before = idx > 0 ? text[idx - 1] : '';
    const after = idx + word.length < text.length ? text[idx + word.length] : '';

    // 如果词语本身包含标点，跳过这个匹配
    let hasPunct = false;
    for (let i = 0; i < word.length; i++) {
      if (isPunctuationOrWhitespace(word[i] ?? '')) {
        hasPunct = true;
        break;
      }
    }
    if (hasPunct) {
      pos = idx + 1;
      continue;
    }

    // 前后应该是标点、空白或文本边界
    const beforeOk = !before || isPunctuationOrWhitespace(before) || /[\p{P}\p{S}]/u.test(before);
    const afterOk = !after || isPunctuationOrWhitespace(after) || /[\p{P}\p{S}]/u.test(after);

    if (beforeOk && afterOk) return idx;
    pos = idx + 1;
  }
}

export function buildRubyAnnotations(i: RubyInput): RubyAnnotation[] {
  const plain = stripMarkers(i.translation);
  const out: RubyAnnotation[] = planFirstPersonRuby({
    source: i.source, translation: i.translation, enabled: i.settings['ruby.first_person'], isDialogue: i.isDialogue,
    speakerType: i.speakerFirstPerson, alreadyAnnotated: i.speakerAlreadyAnnotated,
    ...(i.coverage ? { coverage: i.coverage } : {}), ...(i.previousForm !== undefined ? { previousForm: i.previousForm } : {}),
  }).ruby;

  if (i.settings['ruby.proper_noun'] && i.properNouns?.length) {
    for (const p of i.properNouns) {
      // 使用安全查找，避免匹配到标点内或不完整的词
      const idx = safeFindWord(plain, p.zh);
      if (idx < 0) continue;

      // 检查是否与已有ruby重叠
      if (out.some(r => idx < r.end && idx + p.zh.length > r.start)) continue;

      // 再次验证区间内没有标点（双重保险）
      let hasInnerPunct = false;
      for (let i = idx; i < idx + p.zh.length; i++) {
        if (isPunctuationOrWhitespace(plain[i] ?? '')) {
          hasInnerPunct = true;
          break;
        }
      }
      if (hasInnerPunct) continue;

      out.push({ start: idx, end: idx + p.zh.length, rt: p.rt, kind: 'proper-noun' });
    }
  }

  return out.sort((a, b) => a.start - b.start);
}
