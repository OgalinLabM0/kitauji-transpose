import { createHash } from 'node:crypto';
import type { ProjectStore } from '@core/db';
import { systemPromptFor } from '@core/ai/prompts/systemPrompts';
import { longNaturalnessEvidence, NATURALNESS_SHORT_LIMIT } from './longNaturalnessPlan';
import {NATURALNESS_VISIBLE_CONTRACT} from './naturalnessText';
import {validSourceStyleEvidence} from '../validation/sourceStyleEvidence';

export const NATURALNESS_CONTRACT = 'naturalness-final-v2';
export function naturalnessEvidenceKey(paragraphId: string, inputHash: string, draft: string): string {
  const hash = createHash('sha256').update(JSON.stringify([NATURALNESS_CONTRACT, inputHash, draft, systemPromptFor('naturalness-reviewer'),...(/[⟦⟧]/u.test(draft)?[NATURALNESS_VISIBLE_CONTRACT]:[])])).digest('hex');
  return `naturalness-proof:${paragraphId}:${hash}`;
}
export function naturalnessEvidence(store: ProjectStore, paragraphId: string, inputHash: string, draft: string): string | null {
  const p = store.projects.getParagraph(paragraphId);
  if (!p) return null;
  if (p.sourceText.length + draft.length > NATURALNESS_SHORT_LIMIT) return longNaturalnessEvidence(store, paragraphId, inputHash, draft);
  const key = naturalnessEvidenceKey(paragraphId, inputHash, draft);
  const row = store.db.get<{ value: string }>('SELECT value FROM meta WHERE key=?', [key]);
  if (!row) return null;
  try {
    const value = JSON.parse(row.value);
    if (value?.contract !== NATURALNESS_CONTRACT || value?.decision !== 'keep' || value.assessment?.id !== paragraphId ||
      value.assessment?.decision !== 'keep' || !Array.isArray(value.assessment?.issues) || value.assessment.issues.length !== 0 || typeof value.aiCallId !== 'string') return null;
    const styleCall=store.db.get('SELECT key FROM meta WHERE key=?',[`source-style-call:${value.aiCallId}`]);
    if(styleCall||value.sourceStyle!==undefined)return styleCall&&validSourceStyleEvidence(store,paragraphId,draft,value.aiCallId,value.sourceStyle)?value.aiCallId:null;
    return store.db.get("SELECT id FROM ai_calls WHERE id=? AND error IS NULL AND workstation_id='naturalness-reviewer'", [value.aiCallId]) ? value.aiCallId : null;
  } catch { return null; }
}
