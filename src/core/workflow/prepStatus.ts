import type { ProjectStore } from '../db';
import type { PrepStatus } from '../../shared/ipc';
import { withIdentityRead } from '../db/identitySources';
export function readPrepStatus(s: ProjectStore, vid: string): PrepStatus {
 return withIdentityRead(s.db, () => {
          const volumeId = vid;
          const pids = s.projects.listParagraphIdsByVolume(volumeId);
          const analyses = s.projects.analysesFor(pids);
          for (const pid of analyses.keys()) if (!s.projects.sceneObservation(pid)) analyses.delete(pid);
          const seriesId = s.projects.getVolumeSeriesId(volumeId);
          const chars = s.knowledge.listCharacters(seriesId);
          const terms = s.glossary.activeTerms(seriesId);
          const queue = s.translations.listQueue(seriesId, 'pending');
          // 对话段 / 其中识别出说话人的段：衡量场景分析的实际产出，而不只是"跑过了"
          const placeholders = pids.map(() => '?').join(',');
          const dialogues = pids.length ? (s.db.get<{ c: number }>(`SELECT COUNT(*) c FROM paragraphs WHERE paragraph_type IN ('dialogue','mixed') AND id IN (${placeholders})`, pids)?.c ?? 0) : 0;
          let speakersIdentified = 0;
          for (const [pid, a] of analyses) if (a.speaker_char_id) { const p = s.projects.getParagraph(pid); if (p && p.paragraphType !== 'narration') speakersIdentified++; }
          const translated = pids.length ? (s.db.get<{ c: number }>(`SELECT COUNT(DISTINCT paragraph_id) c FROM translation_finals WHERE paragraph_id IN (${placeholders})`, pids)?.c ?? 0) : 0;
          const chapters = s.projects.listChapters(volumeId).length;
          const prereadChapters = s.projects.prepDoneChapters('preread', volumeId).size;
          const termsChapters = s.projects.prepDoneChapters('terms', volumeId).size;
          return {
            preRead: prereadChapters === chapters, termsExtracted: termsChapters === chapters, scenesAnalyzed: analyses.size, total: pids.length,
            chapters, prereadChapters, termsChapters,
            characters: chars.length, charactersNamed: chars.filter(c => c.canonical_name_zh).length,
            relationships: s.knowledge.relationshipViews(seriesId).length, events: s.db.get<{ c: number }>('SELECT COUNT(*) c FROM narrative_events WHERE series_id=?', [seriesId])?.c ?? 0,
            genderPending: queue.filter(q => q.kind === 'gender-plural').length, stalePending: queue.filter(q => q.kind === 'stale-knowledge').length,
            quirkPending: queue.filter(q => q.kind === 'quirk-candidate').length, quirksLocked: chars.reduce((n, c) => n + s.knowledge.quirks(c.id).filter(q => q.confirmed_by_user).length, 0),
            terms: terms.length, termsUndecided: terms.filter(t => !t.term_zh).length, termProposalsPending: queue.filter(q => q.kind === 'term-proposal').length,
            dialogues, speakersIdentified,
            honorificsTotal: s.db.get<{ c: number }>(`SELECT COUNT(*) c FROM review_queue WHERE series_id=? AND kind='honorific-first'`, [seriesId])?.c ?? 0,
            honorificsPending: queue.filter(q => q.kind === 'honorific-first').length,
            addressesConfirmed: s.db.get<{ c: number }>('SELECT COUNT(*) c FROM address_trajectories WHERE series_id=? AND confirmed_by_user=1', [seriesId])?.c ?? 0,
            honorificsNeedingCandidates: queue.filter(q => q.kind === 'honorific-first' && !('candidates' in q.payload)).length,
            recheckPending: s.translations.pendingRechecks(pids).length, translated,
          };
 });
}
