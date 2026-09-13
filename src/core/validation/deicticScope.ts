import type { ValidationFinding } from '@shared/types';

/** Narrow high-confidence check: a spatial viewing object is not a named person.
 * Pair sentence clauses only when their boundaries agree. Mixed clauses, overt
 * personal reference and multiple viewing predicates remain with semantic review.
 */
export function checkDeicticScope(source: string, translation: string): ValidationFinding[] {
  const src = source.split(/[。！？]/u), zh = translation.split(/[。！？]/u);
  if (src.length !== zh.length) return [];
  const findings: ValidationFinding[] = [];
  for (let i = 0; i < src.length; i++) {
    const clause = src[i]!, target = zh[i]!;
    const spatial = clause.match(/(?:こっち|そっち|あっち|こちら|そちら|あちら)(?:の方)?を見(?:る|ない|ろ|て|た)/u);
    if (!spatial || /私|僕|俺|わたし|あなた|お前|彼|君|自分|見る.{0,12}見/u.test(clause)
      || (clause.match(/見/gu) ?? []).length !== 1) continue;
    // “看我这边” still names a direction; do not mistake its “看我” prefix
    // for a personal object. A following comma does not join that direction.
    const narrowed = target.match(/(?:看|望|瞧|注视)(?:向|着)?[我你他她](?!们|[这那][边里儿])/u);
    if (narrowed) findings.push({ code: 'DEICTIC_SCOPE_NARROWED', severity: 'blocks_export',
      message: '原文观看对象是空间方向，译稿却缩成具体人称；保留这边／那边的范围，不擅自补成我／你／他／她',
      details: { evidence_jp: spatial[0], evidence_zh: narrowed[0] } });
  }
  return findings;
}
