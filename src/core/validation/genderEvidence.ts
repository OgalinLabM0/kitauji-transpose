import { visibleNameSource } from './nameEvidence';

const GENDER_WORDS = /彼女|彼|彼が|彼は|彼の|彼を|彼に|少女|少年|娘|息子|母|父|姉|兄|妹|弟|お嬢|嬢|坊ちゃん|坊や|夫人|奥さん|奥様|妻|夫|王女|王子|姫|女王|女性|男性|女の子|男の子|女子|男子|女|男|婦|紳士|淑女|嫁|婿|おばあ|おじい|お姉|お兄|叔母|叔父|伯母|伯父|婆|爺|ママ|パパ|マム|レディ|ミス|ミセス|she|he|her|his|girl|boy|woman|man|lady|sister|brother|mother|father|daughter|son/i;
const NAME_ONLY_HINT = /名前|名字|名称|という名|らしい名|っぽい名|女性名|男性名|女名|男名|女性的|男性的|女らしい|男らしい|女っぽい|男っぽい|音から|響き|語感|外国名|カタカナ名/;

/** 性别证据守卫；不支持时返回 unknown/null 和 0。 */
export function guardGender(gender: 'male' | 'female' | 'unknown', confidence: number, evidence: string, nameJp: string): { gender: 'male' | 'female' | null; confidence: number } {
  if (gender === 'unknown') return { gender: null, confidence: 0 };
  const ev = (evidence ?? '').trim();
  if (!ev) return { gender: null, confidence: 0 };
  const stripped = (nameJp ? visibleNameSource(ev).split(nameJp).join('') : visibleNameSource(ev)).replace(new RegExp(NAME_ONLY_HINT.source, 'g'), '');
  if (!GENDER_WORDS.test(stripped)) return { gender: null, confidence: 0 };
  return { gender, confidence: Math.min(confidence, 1) };
}
