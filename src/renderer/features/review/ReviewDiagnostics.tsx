import type { ReviewItemView } from '@shared/types';

/** Presentation only: never interpret these labels as an acceptance decision. */
export function needsDiagnosticSummary(text: string): boolean {
  if (typeof text !== 'string') return false;
  return text.length > 160 || /\b[A-Z][A-Z0-9]+_[A-Z0-9_]+\b|\{\s*"|\[\s*\{|Error:|Exception:/.test(text);
}

export function reviewDisplayTitle(item: Pick<ReviewItemView, 'title' | 'kind' | 'payload'>): string {
  if (typeof item.title !== 'string' || !item.title.trim()) return '待查看事项';
  if (!needsDiagnosticSummary(item.title)) return item.title;
  const code = `${typeof item.payload.type === 'string' ? item.payload.type : ''} ${item.title}`;
  if (code.includes('PUNCTUATION_MISMATCH')) return '译文标点需要核对';
  if (code.includes('PRONOUN_HALLUCINATION')) return '译文的人称或人数需要核对';
  if (code.includes('NATURALNESS_UNRESOLVED')) return '这段中文还需要检查读感';
  if (code.includes('MARKER_')) return '正文格式标记需要检查';
  return item.kind === 'failed' ? '这段处理未完成' : item.kind === 'warning' ? '有一项提示需要查看' : '这项内容还需要核对';
}

export function DiagnosticDetails({ value, label = '查看诊断详情' }: { value: unknown; label?: string }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (!text) return null;
  return <details className="small" style={{ margin: '8px 0' }}><summary>{label}</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: 'inherit', maxHeight: 320, overflow: 'auto' }}>{text}</pre></details>;
}

export function ReviewItemDiagnostics({ item }: { item: ReviewItemView }) {
  if (!['failed', 'review-block'].includes(item.kind) && !needsDiagnosticSummary(item.title)) return null;
  return <DiagnosticDetails value={{ title: item.title, ...item.payload }} />;
}
