import { checkPronouns, punctuationSequence } from '../../validation/rules';
import { syntaxHintsFor, speechActHintsFor } from './syntaxHints';

/** Explain the existing deterministic contract beside this source, not a global word ban.
 * No candidate is corrected or accepted here; ordinary validation still decides. */
export function generationConstraints(source: string) {
  const plain = source.replace(/⟦\/?\d+⟧/g, '');
  const unsupportedPronouns = ['他', '她', '他们', '她们', '我们', '咱们'].filter(word =>
    checkPronouns(plain, word).some(f => f.severity === 'blocks_export'));
  const hints = [...syntaxHintsFor(plain, { cognitiveOnly: true }),...speechActHintsFor(source)];
  return {
    ...(hints.length ? { syntax_hints: hints } : {}),
    punctuation_sequence: punctuationSequence(source).map(c => c === ',' ? '，' : c).join(''),
    punctuation_instruction: '这是本块标点的完整顺序（不含正文），译文逐个保留；用自然句法衔接，不增加逗号、破折号或句末标点。',
    unsupported_pronouns: unsupportedPronouns,
    pronoun_instruction: '这些代词在本块没有原文明示依据，不得补入；省略处调整句法使中文完整，不能只删代词留下悬空句，也不能改补名字或身份。词内的“他”（如吉他）不属于代词。',
  };
}
