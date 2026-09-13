import type { ValidationFinding } from '@shared/types';
import { LongNaturalnessBoundaryError, makeLongReadingPlan, NATURALNESS_SHORT_LIMIT } from './longNaturalnessPlan';

export const LONG_READING_BOUNDARY_CODE = 'LONG_NATURALNESS_NEEDS_BOUNDARY';

/** Structural limits are not a prose defect. Never ask an editor to rewrite around them. */
export function longReadingBoundary(paragraph: { id: string; sourceText: string; paragraphType: string }, draft: string): ValidationFinding | null {
  if (paragraph.sourceText.length + draft.length <= NATURALNESS_SHORT_LIMIT) return null;
  try {
    // A boundary preflight only: this never creates a checkpoint or a successful proof.
    makeLongReadingPlan(paragraph.id, paragraph.sourceText, draft, paragraph.paragraphType, 'boundary-preflight');
    return null;
  } catch (error) {
    if (!(error instanceof LongNaturalnessBoundaryError)) throw error;
    return { code: LONG_READING_BOUNDARY_CODE, severity: 'blocks_export',
      message: `长段暂不能安全分块检查（中文位置 ${error.start + 1}–${error.end}），完整稿保留待处理。请在阅读对照中核对该范围；如果导入分段有误，修正输入文件后重新导入。原文确实没有可用边界时，本版本暂停该段，不自动改写，也不能通过改标点或删内容绕过检查。`,
      details: { start: error.start, end: error.end, recoverableBy: 'correct-source-boundaries-or-supported-reader' } };
  }
}
