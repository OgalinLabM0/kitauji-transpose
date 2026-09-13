/** Recognize only complete non-finding statements, never a substring of a diagnosis.
 * This validates the review protocol, not the truth of a linguistic judgment.
 * A contradictory response must be retried; it must never become a clean review.
 */
export function isExplicitNonFinding(reason: string): boolean {
  return /^(?:无问题|没有问题|无明确问题|没有明确问题|未发现问题|未发现明确问题|无遗漏或增添|无明确遗漏或增添|无需修改|不需要修改)[。.!！\s]*$/u.test(reason.trim());
}
