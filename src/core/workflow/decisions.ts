import { englishRubyNotes, englishRubySchema } from './termEnglishRuby';
import {inheritForeignNotes} from './foreignNotes';
import { beginKnowledgeDecision, finishKnowledgeDecision } from './knowledgeDecisionJournal';
import { beginChangeDecision, finishChangeDecision } from './changeDecisionJournal';
import { applyFieldConflict, scheduleFieldRechecks, type FieldConflict } from './characterConflicts';
/**
 * 用户决定回写（docs/设计/REVIEW_ROUTING.md 第 5 节）。
 * 每个复核队列项的决定：写入知识库确定性部分 → 计算影响范围 → 已翻译且受影响的段落进 recheck_tasks（不自动重译，由用户触发“重译回查段”）。
 */
import type { ProjectStore } from '@core/db';
import type { ReviewKind, DraftBase } from '@shared/types';
import { relocateRubyAnnotations } from './rubyAnnotations';

export type Decision =
  | { kind: 'failed'; action: 'retry' | 'dismiss' }
  | { kind: 'review-block'; action: 'accept-as-is' | 'edit'; text?: string; base?: DraftBase }
  | { kind: 'lock-conflict'; action: 'keep-lock' | 'change-lock'; newZh?: string }
  | { kind: 'honorific-first'; action: 'choose'; zh: string; allowVariation?: boolean; relationStage?: string | null; applyToText?: boolean }
  | { kind: 'quirk-candidate'; action: 'confirm' | 'reject'; pattern?: string }
  | { kind: 'gender-plural'; action: 'confirm' | 'set'; gender?: string | null; plurality?: string }
  | { kind: 'term-proposal'; action: 'choose' | 'reject'; zh?: string; lockLevel?: 'confirmed' | 'hard-locked'; acceptVariants?: boolean; englishRuby?: { english: string; gloss: string } }
  | { kind: 'wordplay'; action: 'accept' | 'custom' | 'literal'; zh?: string; notes?: string | null }
  | { kind: 'ambiguity'; action: 'confirm' | 'set'; zh?: string; addAsSense?: boolean; createTerm?: boolean; termType?: string }
  | { kind: 'glossary-deviation'; action: 'accept-here' | 'add-sense' | 'revert'; senseGloss?: string | null; contextHint?: string | null }
  | { kind: 'stale-knowledge'; action: 'accept' | 'reject' }
  | { kind: 'warning'; action: 'dismiss' };

export interface DecisionResult { ok: boolean; message: string; recheckCount: number; retranslate: string[] }

export class DecisionService {
  constructor(private readonly store: ProjectStore) {}

  apply(queueItemId: string, d: Decision): DecisionResult {
    const item = this.store.translations.getQueueItem(queueItemId);
    if (!item) return { ok: false, message: '队列项不存在', recheckCount: 0, retranslate: [] };
    if (item.status !== 'pending') return { ok: false, message: '该复核项已处理，请刷新后重试', recheckCount: 0, retranslate: [] };
    if (item.kind !== d.kind) return { ok: false, message: `决定类型 ${d.kind} 与队列项 ${item.kind} 不匹配`, recheckCount: 0, retranslate: [] };
    if (!KIND_ACTIONS[d.kind]?.includes(d.action)) return { ok: false, message: '此类复核不支持该操作', recheckCount: 0, retranslate: [] };
    const pl = item.payload as Record<string, any>;
    const seriesId = item.series_id;
    const para = item.paragraph_id ? this.store.projects.getParagraph(item.paragraph_id) : undefined;
    const at = para?.seriesOrdinal ?? 0;
    if (para && this.store.projects.getSeriesIdOfParagraph(para.id) !== seriesId) return {ok:false,message:'决定的原文不属于当前作品',recheckCount:0,retranslate:[]};
    const retranslate: string[] = []; let recheckCount = 0; let message = '已处理';
    // 目标对象缺失等无法落库的情况：不 resolve 队列项、返回 ok:false，避免"看起来确认了、实际术语表没写"的静默失败
    let failed: string | null = null;
    const recheckContaining = (needle: string, reason: string, exceptId?: string | null): void => {
      for (const p of this.store.projects.translatedParagraphsContaining(seriesId, needle)) { if (p.id === exceptId) continue; this.store.translations.addRecheck(p.id, 'user-decision', reason); recheckCount++; }
    };

    this.store.db.transaction(() => {
      const journal = beginKnowledgeDecision(this.store,queueItemId);
      const changeJournal = d.kind === 'stale-knowledge' && pl.subtype !== 'character-field' ? beginChangeDecision(this.store, queueItemId, d.action === 'accept') : undefined;
      switch (d.kind) {
        case 'failed':
          if (d.action === 'retry') {
            if (!item.paragraph_id) { failed = '缺少待重译段落，无法重试'; break; }
            retranslate.push(item.paragraph_id);
          }
          message = d.action === 'retry' ? '已加入重译队列，完成审校后关闭此项' : '已忽略'; break;

        case 'review-block': {
          if (!item.paragraph_id || !this.store.translations.latestFinal(item.paragraph_id)) { failed = '当前译稿不存在，无法确认'; break; }
          if (d.action === 'edit') {
            if (!d.text?.trim()) { failed = '译文不能为空'; break; }
            this.editFinal(item.paragraph_id, d.text, true, d.base);
          } else this.store.translations.confirmFinal(item.paragraph_id);
          this.store.translations.addRecheck(item.paragraph_id, 'manual-review', '人工已采纳当前稿，需要复核当前文字');
          message = '已记录人工采纳，原问题保留；请复核当前稿'; break;
        }

        case 'lock-conflict': {
          if (d.action === 'change-lock' && d.newZh && pl.termId) {
            const term = this.store.glossary.activeTerms(seriesId).find(t => t.id === pl.termId);
            if (term) { this.store.glossary.upsertTerm({ seriesId, introducedVolume: term.introduced_volume, termJp: term.term_jp, termZh: d.newZh, termType: term.term_type, lockLevel: 'hard-locked' }); recheckContaining(term.term_jp, `硬锁定术语「${term.term_jp}」改为“${d.newZh}”`); if (item.paragraph_id) retranslate.push(item.paragraph_id); message = `锁定已改为“${d.newZh}”，影响段落已进回查`; }
          } else { if (pl.occurrenceId) this.store.glossary.setOccurrenceStatus(pl.occurrenceId, 'rejected'); message = '维持锁定'; }
          break;
        }

        case 'honorific-first': {
          const spk = pl.speakerCharId as string | null, tgt = pl.targetCharId as string | null;
          if (!spk || !tgt || this.store.knowledge.getCharacter(spk)?.series_id !== seriesId || this.store.knowledge.getCharacter(tgt)?.series_id !== seriesId) { failed = '说话人或受话人未识别，请先在人物面板建档并重新解析'; break; }
          if (!para || typeof pl.sourceFormJp !== 'string' || !pl.sourceFormJp.trim()) { failed = '缺少称呼原文或出现位置，请重新解析'; break; }
          if (!d.zh?.trim()) { failed = '请输入称呼译名'; break; }
          const prev = this.store.knowledge.activeAddress(seriesId, spk, tgt, pl.sourceFormJp, at);
          if (prev && prev.translated_form !== d.zh) this.store.knowledge.endAddress(prev.id, at);
          if (!prev || prev.translated_form !== d.zh) this.store.knowledge.addAddress({ seriesId, speakerCharId: spk, targetCharId: tgt, sourceFormJp: pl.sourceFormJp, translatedForm: d.zh, relationStage: d.relationStage ?? pl.relationStage ?? null, allowVariation: !!d.allowVariation, validFromPara: prev && prev.translated_form !== d.zh ? at : (prev?.valid_from_para ?? Math.max(1, at)), confirmedByUser: true, evidenceIds: item.paragraph_id ? [item.paragraph_id] : [] });
          else this.store.db.run('UPDATE address_trajectories SET confirmed_by_user=1, allow_variation=? WHERE id=?', [d.allowVariation ? 1 : 0, prev.id]);
          // 已译且含该称呼、但译法不同的段落进回查
          for (const p of this.store.projects.translatedParagraphsContaining(seriesId, pl.sourceFormJp)) {
            if ((this.store.projects.getParagraph(p.id)?.seriesOrdinal ?? 0) < at) continue;
            const a = this.store.projects.currentAnalysis(p.id);
            if (a && a.speaker_char_id && a.speaker_char_id !== spk) continue;
            if (!p.finalText.includes(d.zh)) { this.store.translations.addRecheck(p.id, 'user-decision', `称呼「${pl.sourceFormJp}」已锁定为“${d.zh}”`); recheckCount++; }
          }
          if (d.applyToText !== false && item.paragraph_id && pl.usedZh !== d.zh) retranslate.push(item.paragraph_id);
          message = `称呼已锁定为“${d.zh}”${retranslate.length ? '，将按说话人与原文重新翻译本段' : ''}`; break;
        }

        case 'quirk-candidate': {
          const cid = pl.characterId as string | null;
          if (!cid || this.store.knowledge.getCharacter(cid)?.series_id !== seriesId) { failed = '人物未识别或不属于当前作品，请先建档'; break; }
          if (typeof pl.triggerForm !== 'string' || !pl.triggerForm.trim() || (d.action === 'confirm' && (typeof (d.pattern ?? pl.proposedPattern) !== 'string' || !(d.pattern ?? pl.proposedPattern).trim()))) { failed = '语癖形式和译法不能为空'; break; }
          if (d.action === 'confirm') {
            this.store.knowledge.confirmQuirk(cid, { quirk_type: `${pl.triggerForm}型`, trigger_form: pl.triggerForm, translation_pattern: d.pattern ?? pl.proposedPattern, locked_at_para: at, evidence_ids: item.paragraph_id ? [item.paragraph_id] : [] });
            // 该人物已译发言中含触发形式但无译法的段落进回查
            for (const p of this.store.projects.translatedParagraphsContaining(seriesId, pl.triggerForm)) {
              if ((this.store.projects.getParagraph(p.id)?.seriesOrdinal ?? 0) < at) continue;
              const speaker = this.store.projects.currentAnalysis(p.id)?.speaker_char_id;
              if (speaker && speaker !== cid) continue;
              if (!p.finalText.includes(d.pattern ?? pl.proposedPattern)) { this.store.translations.addRecheck(p.id, 'user-decision', `语癖「${pl.triggerForm}」已锁定`); recheckCount++; }
            }
            message = `语癖已锁定：${pl.triggerForm}→${d.pattern ?? pl.proposedPattern}`;
          } else {
            const list = this.store.knowledge.quirks(cid).filter(q => q.trigger_form !== pl.triggerForm);
            list.push({ quirk_id: `rejected-${pl.triggerForm}`, quirk_type: 'rejected', trigger_form: pl.triggerForm, translation_pattern: '', confirmed_by_user: false, locked_at_para: at, evidence_ids: [] });
            this.store.knowledge.setQuirks(cid, list);
            message = '已否定，此后同形式不再提示（可在人物面板移除）';
          }
          break;
        }

        case 'gender-plural': {
          const cid = pl.characterId as string | null; if (!cid || !this.store.knowledge.getCharacter(cid)) { failed = '人物未识别，请先在人物面板建档'; break; }
          if (this.store.knowledge.getCharacter(cid)!.series_id !== seriesId) { failed = '人物不属于当前作品'; break; }
          const evidenceIds = Array.isArray(pl.evidenceIds) ? pl.evidenceIds as string[] : [];
          const evidence = evidenceIds.map(pid => this.store.projects.getParagraph(pid));
          if (evidence.some(p => !p || this.store.projects.getSeriesIdOfParagraph(p.id) !== seriesId)) { failed = '人物决定的原文证据已失效，请重新核对'; break; }
          const knownAt = Math.max(at, ...evidence.map(p => p!.seriesOrdinal));
          const gender = d.action === 'set' && Object.hasOwn(d, 'gender') ? d.gender ?? null : pl.gender ?? null;
          this.store.knowledge.updateCharacter(cid, { gender, genderConfidence: gender === null || gender === 'unknown' ? 0 : 1, ...(d.plurality ? { plurality: d.plurality } : {}) }, knownAt);
          message = '人物性别/人数已锁定'; break;
        }

        case 'term-proposal': {
          const term = this.store.glossary.activeTerms(seriesId).find(t => t.id === pl.termId);
          if (!term) { if (d.action === 'reject') { message = '术语已不存在，提案已关闭'; break; } failed = `术语「${pl.termJp ?? ''}」已不在术语表中（可能已被删除），无法写入译名；可「不是术语」关闭此提案`; break; }
          if (d.action === 'reject') { this.store.glossary.deleteTerm(term.id); message = '已从术语表移除'; break; }
          if (d.englishRuby) { const check=englishRubySchema.safeParse(d.englishRuby); if(!check.success){failed='英文原形或中文注释格式不正确';break;} d.zh=check.data.english; }
          if (!d.zh?.trim()) { failed = '未提供译名'; break; }
          this.store.glossary.upsertTerm({ seriesId, introducedVolume: term.introduced_volume, termJp: term.term_jp, termZh: d.zh, termType: term.term_type, lockLevel: d.lockLevel ?? 'confirmed', ...(d.englishRuby ? {notes:englishRubyNotes(term.notes,d.englishRuby)} : {}) });
          // 人名译名同步到人物档案中文名（档案为空时）
          const synced = this.store.knowledge.syncNameZhFromTerm(seriesId, term.term_jp, d.zh);
          if (d.acceptVariants && Array.isArray(pl.variants)) for (const v of pl.variants as { variant_jp: string; zh: string; variant_type: string; relation_stage: string | null; scene_scope: string | null; evidence_ids: string[] }[]) this.store.glossary.addVariant({ termId: term.id, variantJp: v.variant_jp, variantZh: v.zh, variantType: v.variant_type, relationStage: v.relation_stage, sceneScope: v.scene_scope, evidenceIds: v.evidence_ids });
          for (const p of this.store.projects.translatedParagraphsContaining(seriesId, term.term_jp)) if (!p.finalText.includes(d.zh)) { this.store.translations.addRecheck(p.id, 'user-decision', `术语「${term.term_jp}」确认为“${d.zh}”`); recheckCount++; }
          message = `术语已确认：${term.term_jp}→${d.zh}${synced ? '，已同步为人物中文名' : ''}`; break;
        }

        case 'wordplay': {
          const id = pl.wordplayId as string;
          const zh = d.action === 'accept' ? (pl.proposal as string | null) : d.action === 'custom' ? d.zh : null;
          if (d.action === 'literal') { this.store.translations.decideWordplay(id, `[直译+注]${d.zh ?? pl.meaning}`, d.notes ?? '放弃谐音，直译并加注'); message = '已决定：直译加注'; }
          else if (zh) { this.store.translations.decideWordplay(id, zh, d.notes ?? null); recheckContaining(pl.variant, `谐音「${pl.variant}」已决定为“${zh}”`, item.paragraph_id); if (item.paragraph_id) retranslate.push(item.paragraph_id); message = `谐音已决定：“${zh}”，本段重译并回查同类`; }
          break;
        }

        case 'ambiguity': {
          const zh = d.action === 'set' ? d.zh : (pl.preSelected ?? pl.inferred ?? pl.usedZh);
          if (!zh) { failed = '未提供译名（推断为空且未选择候选）'; break; }
          let termId = pl.termId as string | null;
          if (!termId && d.createTerm !== false) termId = this.store.glossary.upsertTerm({ seriesId, introducedVolume: para ? this.store.projects.listVolumes(seriesId).find(v => this.store.projects.listParagraphIdsByVolume(v.id).includes(para.id))?.volumeNumber ?? 1 : 1, termJp: pl.termJp, termZh: zh, termType: d.termType ?? 'concept', lockLevel: 'confirmed' });
          else if (termId && d.addAsSense) { const t = this.store.glossary.activeTerms(seriesId).find(x => x.id === termId); if (t && !t.senses.some(s => s.sense_zh === zh)) this.store.glossary.addSense(termId, zh, null, null, true, item.paragraph_id ? [item.paragraph_id] : []); }
          else if (termId) { const t = this.store.glossary.activeTerms(seriesId).find(x => x.id === termId); if (t) this.store.glossary.upsertTerm({ seriesId, introducedVolume: t.introduced_volume, termJp: t.term_jp, termZh: zh, termType: t.term_type, lockLevel: 'confirmed' }); }
          if (item.paragraph_id && zh !== (pl.inferred ?? pl.usedZh)) retranslate.push(item.paragraph_id);
          this.store.knowledge.syncNameZhFromTerm(seriesId, pl.termJp, zh); // 若歧义词恰为人名，同步人物中文名
          message = `「${pl.termJp}」已确定为“${zh}”`; break;
        }

        case 'glossary-deviation': {
          const occId = pl.occurrenceId as string | undefined;
          if (d.action === 'accept-here') { if (occId) this.store.glossary.setOccurrenceStatus(occId, 'accepted'); message = '已接受本处偏离'; }
          else if (d.action === 'add-sense') {
            const t = this.store.glossary.activeTerms(seriesId).find(x => x.id === pl.termId);
            if (t) { const sid = t.senses.find(s => s.sense_zh === pl.usedZh)?.id ?? this.store.glossary.addSense(t.id, pl.usedZh, d.senseGloss ?? null, d.contextHint ?? null, true, item.paragraph_id ? [item.paragraph_id] : []); if (occId) this.store.glossary.setOccurrenceStatus(occId, 'promoted', sid); message = `已新增义项“${pl.usedZh}”，此后按义项选择不再提醒`; }
          } else { if (occId) this.store.glossary.setOccurrenceStatus(occId, 'rejected'); if (item.paragraph_id) retranslate.push(item.paragraph_id); message = '已改回术语表译法，本段重译'; }
          break;
        }

        case 'stale-knowledge':
          if (pl.subtype === 'character-field') {
            if (d.action === 'accept') recheckCount += applyFieldConflict(this.store, pl as FieldConflict, seriesId);
            message = d.action === 'accept' ? '已从证据位置采纳该字段，原有其他字段保留；可在人物页撤销' : '已拒绝此候选，原记录保留';
            break;
          }
          this.store.knowledge.resolveChangeCandidate(pl.candidateId, d.action === 'accept', seriesId);
          if (d.action === 'accept') {
            const candidate = this.store.db.get<{triggered_at_para: number; proposed_valid_to_para: number | null}>('SELECT triggered_at_para,proposed_valid_to_para FROM knowledge_change_candidates WHERE id=?', [pl.candidateId])!;
            recheckCount += scheduleFieldRechecks(this.store, seriesId, candidate.proposed_valid_to_para ?? candidate.triggered_at_para, '知识生效范围已变化，需要复核当前稿');
          }
          message = d.action === 'accept' ? '知识已标记失效' : '已保留'; break;

        case 'warning': message = '已忽略'; break;
      }
      if (!failed) {
        if (journal) finishKnowledgeDecision(this.store,queueItemId,journal);
        if (d.kind === 'term-proposal' && pl.legacyAutomaticTermReview) {
          const payload = { ...this.store.translations.getQueueItem(queueItemId)!.payload };
          // Original automatic provenance is retained in the reopening snapshot; the new decision is human.
          delete payload.automaticTermDecision; delete payload.automaticSources;
          delete payload.legacyAutomaticTermReview;
          this.store.translations.updateQueuePayload(queueItemId, payload);
        }
        if (changeJournal) finishChangeDecision(this.store, queueItemId, changeJournal);
        for (const paragraphId of retranslate) this.store.translations.addRecheck(paragraphId, 'decision-repair', `决定后需要重新验证：${queueItemId}`);
        if (!(d.kind === 'failed' && d.action === 'retry') && d.kind !== 'review-block') this.store.translations.resolveQueueItem(queueItemId, JSON.stringify(d), d.action === 'dismiss' || d.action === 'reject' ? 'dismissed' : 'resolved');
      }
    });
    if (failed) return { ok: false, message: failed, recheckCount: 0, retranslate: [] };
    this.store.translations.log({ level: 'info', paragraphId: item.paragraph_id, message: `用户决定 [${item.kind}] ${message}${recheckCount ? `；回查 ${recheckCount} 段` : ''}` });
    return { ok: true, message, recheckCount, retranslate };
  }

  /** 直接（不经队列）编辑并确认某段译文 */
  editFinal(paragraphId: string, text: string, confirm = true, base?: DraftBase): void {
    if (!text.trim()) throw new Error('译文不能为空');
    if (!this.store.projects.getParagraph(paragraphId)) throw new Error('段落不存在');
    const f = this.store.translations.latestFinal(paragraphId);
    if (base && (!Number.isSafeInteger(base.version) || base.version !== (f?.version ?? 0) || base.sourceText !== this.store.projects.getParagraph(paragraphId)!.sourceText)) throw new Error('原文或译稿已更新，未覆盖新版本。草稿仍保留，请对照当前稿后重新编辑');
    this.store.transaction(() => {
      const ruby = f ? relocateRubyAnnotations(f.final_text, text, this.store.translations.rubyOf(f)) : [];
      let sourceCandidateId=f?.final_text===text?f.source_candidate_id:null;
      const prior=f?.source_candidate_id?this.store.translations.candidateById(f.source_candidate_id):undefined;
      if(f&&prior?.candidate_text===f.final_text&&prior.paragraph_id===paragraphId&&f.final_text!==text){
        const notes=inheritForeignNotes(this.store.projects.getParagraph(paragraphId)!.sourceText,text,[],JSON.parse(prior.flags??'[]'));
        if(notes.length){
          // This is an unreviewed user manuscript snapshot: no model call or audit is invented.
          sourceCandidateId=this.store.translations.addCandidate({paragraphId,workstationId:'chinese-editor',text,flags:notes,sourceCoverage:[],aiCallId:null});
          this.store.translations.log({level:'info',paragraphId,message:'人工编辑保留仍有原文依据的译注，正文与译注均须重新检查；未沿用旧审校凭据'});
        }
      }
      this.store.translations.setFinal({ paragraphId, text, ruby, sourceCandidateId, confirmedByUser: confirm });
      this.store.translations.addRecheck(paragraphId, 'manual-edit', '人工编辑后需要复核当前稿；重新生成标注');
    });
  }
  confirm(paragraphIds: string[]): number { let n = 0; for (const id of paragraphIds) if (this.store.translations.latestFinal(id)) { this.store.translations.confirmFinal(id); n++; } return n; }
  unconfirm(paragraphIds: string[]): void { for (const id of paragraphIds) this.store.translations.unconfirmFinal(id); }
}

export const KIND_ACTIONS: Record<ReviewKind, string[]> = {
  failed: ['retry', 'dismiss'], 'review-block': ['accept-as-is', 'edit'], 'lock-conflict': ['keep-lock', 'change-lock'],
  'honorific-first': ['choose'], 'quirk-candidate': ['confirm', 'reject'], 'gender-plural': ['confirm', 'set'],
  'term-proposal': ['choose', 'reject'], wordplay: ['accept', 'custom', 'literal'], ambiguity: ['confirm', 'set'],
  'glossary-deviation': ['accept-here', 'add-sense', 'revert'], 'stale-knowledge': ['accept', 'reject'], warning: ['dismiss'],
};
