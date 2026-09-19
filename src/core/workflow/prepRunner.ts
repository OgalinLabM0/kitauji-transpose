import { hasVerifiedNameMention } from './nameMentionReceipts';
import { quarantineInitialFields } from '../db/initialFieldTrust';
import { loadTermExtractionCheckpoint, saveTermExtractionCheckpoint } from './termExtractionCheckpoint';
import { termProposalContext } from './termProposalContext';
import { sceneNameCandidates, sceneNameCandidateSourceIds } from './sceneNameCandidates';
import { knownNameIdentities, preReadIdentityInput, withIdentityDependencies, withIdentityRead, type BackgroundIdentityEvent } from '../db/identitySources';
import { supersedeChangeCandidates } from '../db/knowledgeChanges';
import { bindNarrativeSources, supersedeNarrativeBatch, preReadBackground, eventSourceFingerprint } from '../db/narrativeSources';
import { splitPreRead } from './splitPreRead';
/**
 * 预处理工位 runner（docs/设计/PLAN_历史架构.md 第 5 节 / REVIEW_ROUTING 第 1 节”翻译前”）。
 * 顺序：book-pre-reader（按章）→ term-extractor（按章聚合）→ term-translation-proposer → scene-analyst（按场景）。
 * honorific-resolver 按需：针对队列中的 honorific-first 项生成候选。
 * 全部输出是候选：写入数据库的确定性部分只在用户确认后发生；本文件只写”候选/未确认”状态。
 */
import type { ProjectStore } from '@core/db';
import { resolveEntityNameBidirectional, KnowledgeRepo, bestZhName, renderAddressForm, hasKana, HONORIFIC_SUFFIX_RE } from '@core/db';
import { AiClient, AiCallFailed, ProviderError, buildContextPack, parseScene, parsePreRead, parseTermExtract, parseTermProposal, parseHonorific, type PreReadOutput } from '@core/ai';
import type { WorkflowProgress } from '@shared/types';
import { selectTermCandidates } from './termSelection';
import { missingTermProposals } from './termPreparation';
import { reconcileTermCandidates } from './termCandidatePolicy';
import { isHanOnlyTerm, termSplitReceipt, type TermSplitReceipt } from '../validation/termGranularity';
import { observeWithConflicts } from './characterConflicts';
import { PreReadCheckpoint } from './preReadCheckpoint';
import { visibleNameSource, containsVisibleQuote, type NameEvidence } from '../validation/nameEvidence';
import { guardGender } from '../validation/genderEvidence';
export { guardGender } from '../validation/genderEvidence';

export interface PrepOptions { onProgress?: (p: WorkflowProgress) => void; signal?: AbortSignal; chapterBatchChars?: number }


const chunkByChars = <T extends { sourceText: string }>(items: T[], maxChars: number, maxParagraphs = Infinity): T[][] => {
  const out: T[][] = []; let cur: T[] = []; let n = 0;
  for (const it of items) { if (cur.length && (n + it.sourceText.length > maxChars || cur.length >= maxParagraphs)) { out.push(cur); cur = []; n = 0; } cur.push(it); n += it.sourceText.length; }
  if (cur.length) out.push(cur);
  return out;
};

export class PrepRunner {
  readonly progress: WorkflowProgress = { running: false, paused: false, phase: 'idle', done: 0, total: 0, currentParagraphId: null, costUsd: 0, inputTokens: 0, outputTokens: 0, message: '' };
  constructor(private readonly store: ProjectStore, private readonly ai: AiClient, private readonly opts: PrepOptions = {}) {}
  private emit(patch: Partial<WorkflowProgress>): void {
    Object.assign(this.progress, patch.phase && patch.phase !== this.progress.phase && patch.phase !== 'idle' ? { detail: null } : {}, patch, { costUsd: this.ai.totals.costUsd, inputTokens: this.ai.totals.inputTokens, outputTokens: this.ai.totals.outputTokens });
    this.opts.onProgress?.({ ...this.progress });
  }
  private check(): void { if (this.opts.signal?.aborted) throw new ProviderError('abort', '已取消'); }

  private paragraphsOf(chapterId: string) {
    return this.store.projects.listParagraphIdsByChapter(chapterId).map(id => this.store.projects.getParagraph(id)!).filter(Boolean);
  }
  private volumeNumberOf(volumeId: string): number {
    const seriesId = this.store.projects.getVolumeSeriesId(volumeId);
    return this.store.projects.listVolumes(seriesId).find(v => v.id === volumeId)?.volumeNumber ?? 1;
  }

  // ---------------------------------------------------------------- 全书预读
  /** 按章节顺序预读一册；每章一次调用（超长章按字数切分），把人物/关系/事件写为候选。 */
  async preRead(volumeId: string, chapterIds?: string[]): Promise<{ characters: number; relationships: number; events: number; changes: number; merged: number; quirks: number }> {
    const seriesId = this.store.projects.getVolumeSeriesId(volumeId);
    quarantineInitialFields(this.store,seriesId);
    const volNo = this.volumeNumberOf(volumeId);
    const chapters = this.store.projects.listChapters(volumeId).filter(c => !chapterIds || chapterIds.includes(c.id));
    const stats = { characters: 0, relationships: 0, events: 0, changes: 0, merged: 0, quirks: 0 };
    this.emit({ detail: null, running: true, phase: '全书预读', done: 0, total: chapters.length, message: `预读 ${chapters.length} 章` });
    const failedChapters: string[] = [];
    try {
      for (const ch of chapters) {
        this.check();
        const chapterSource = this.store.projects.chapterSourceSignature(ch.id);
        const checkpoint = new PreReadCheckpoint(this.store, ch.id, this.store.projects.prepDoneChapters('preread', volumeId).has(ch.id));
        this.store.projects.clearPrepDone('preread', [ch.id]);
        const paras = this.paragraphsOf(ch.id);
        const chapterLabel = ch.title ?? `第${ch.chapterNumber}章`;
        if (!paras.length) { this.store.projects.markPrepDone('preread', ch.id, chapterSource); this.emit({ message: `预读「${chapterLabel}」：已核对 0/0 段`, done: this.progress.done + 1 }); continue; }
        // 块失败 → 二分拆块重试到单段；任一单段仍失败则本章不标完成（重跑只补这些章）
        let chapterOk = true;
        let processedParagraphs = 0;
        const detail = (label = '预读本章') => ({ phase: 'preread', label, done: processedParagraphs, total: paras.length, unit: '段' as const, chapterTitle: chapterLabel });
        this.emit({ detail: detail(), message: `预读「${chapterLabel}」：开始，已核对 0/${paras.length} 段` });
        const work: typeof paras[] = chunkByChars(paras, Math.min(this.opts.chapterBatchChars ?? 3000, 3000), 32);
        while (work.length) {
          const remaining = work.shift()!;
          this.check();
          const done = checkpoint.doneMany(remaining);
          let leading = 0;
          while (leading < remaining.length && done[leading]) leading++;
          if (leading) {
            processedParagraphs += leading;
            remaining.splice(0, leading);
            this.emit({ detail: detail(), message: `预读「${chapterLabel}」：已核对 ${processedParagraphs}/${paras.length} 段` });
          }
          if (!remaining.length) continue;
          const boundary = done.slice(leading).findIndex(Boolean);
          const batch = boundary > 0 ? remaining.splice(0, boundary) : remaining;
          // Reassess the trailing work after this batch changes its background facts.
          if (boundary > 0) work.unshift(remaining);
          const batchText = batch.map(p => p.sourceText).join('\n');
          // Extraction gets source-only, bounded context: no later character state or Chinese drafts.
          const background = preReadBackground(this.store.db, seriesId, batch[0]!.seriesOrdinal);
          const backgroundEvents: BackgroundIdentityEvent[] = background.events.map(e => ({ id: e.id, atPara: e.at_para, fingerprint: eventSourceFingerprint(this.store.db, e.id) }));
          const identities = knownNameIdentities(this.store.db, seriesId, batch[0]!.seriesOrdinal, batchText, background.events.map(e => e.summary_jp).join('\n'));
          const knownNames = identities.map(d => d.name).sort();
          const identityInput = preReadIdentityInput(this.store.db, seriesId, batch[0]!.seriesOrdinal, batch.map(p => p.id), backgroundEvents);
          const user = JSON.stringify({
            known_names: knownNames,
            previous_events: background.events.map(e => ({ at_para: e.at_para, summary_jp: e.summary_jp })),
            paragraphs: batch.map(p => ({ id: p.id, seriesOrdinal: p.seriesOrdinal, source: visibleNameSource(p.sourceText) })),
          });
          const checkBatch = () => {
            this.check();
            const currentBackground = preReadBackground(this.store.db, seriesId, batch[0]!.seriesOrdinal);
            const currentIdentities = knownNameIdentities(this.store.db, seriesId, batch[0]!.seriesOrdinal, batchText, currentBackground.events.map(e => e.summary_jp).join('\n'));
            if (JSON.stringify(currentIdentities) !== JSON.stringify(identities)) throw new Error('预读姓名依据在调用期间已变化，请继续本册重新核对');
            if (preReadBackground(this.store.db, seriesId, batch[0]!.seriesOrdinal).signature !== background.signature) throw new Error('预读背景依据在调用期间已变化，旧结果未写入，请继续本册重试');
          if (batch.some(p => {
            const current = this.store.projects.getParagraph(p.id);
            return !current || current.sourceText !== p.sourceText || current.seriesOrdinal !== p.seriesOrdinal || current.chapterId !== p.chapterId || current.paragraphType !== p.paragraphType;
          })) throw new Error('预读原文或段落位置在调用期间已变化，旧结果未写入，请继续本册重新核对');
          };
          let out: PreReadOutput;
          try { out = await splitPreRead(this.ai, user, batch, knownNames, checkBatch, this.opts.signal, label => this.emit({ detail: detail(label), message: `${label} · ${chapterLabel} · 已核对 ${processedParagraphs}/${paras.length} 段` }), this.store); }
          catch (e) {
            if (!(e instanceof AiCallFailed) || e.lastError instanceof ProviderError && !['shape','truncated'].includes(e.lastError.kind)) throw e;
            if (batch.length > 1) { const mid = Math.ceil(batch.length / 2); work.unshift(batch.slice(0, mid), batch.slice(mid)); this.store.translations.log({ level: 'warning', workstationId: 'book-pre-reader', paragraphId: batch[0]!.id, message: `预读块失败（${batch.length} 段）：${e.message}；拆成两半重试` }); this.emit({ detail: detail('自动缩小批次重试'), message: `正在自动缩小处理范围（${batch.length} → ${mid} 段），已完成部分保留，无需操作` }); continue; }
            chapterOk = false; this.store.translations.log({ level: 'error', workstationId: 'book-pre-reader', paragraphId: batch[0]!.id, message: `预读失败（单段 §${batch[0]!.seriesOrdinal}）：${e.message}` }); continue;
          }
          this.check();

          withIdentityDependencies(this.store.db, identities, () => this.store.db.transaction(() => {
            supersedeNarrativeBatch(this.store.db, seriesId, batch.map(p => p.id));
            const idOf = new Map<string, string>();
            const batchAt = Math.max(...batch.map(p => p.seriesOrdinal));
            for (const c of out.characters) {
              const reviewedNameEvidence:NameEvidence|undefined=c.name_evidence;
              // 代词/职称不是人名：「僕」「私」「少尉」「中隊長」一律不建档（AI 常把一人称当人物输出）
              if (KnowledgeRepo.isGenericName(c.name_jp) && !(reviewedNameEvidence?.reviewId && hasVerifiedNameMention(this.store,reviewedNameEvidence.paragraph_id,c.name_jp,reviewedNameEvidence.reviewId))) { this.store.translations.log({ level: 'info', workstationId: 'book-pre-reader', paragraphId: c.evidence_ids[0] ?? null, message: `「${c.name_jp}」是代词/职称，不作为人物建档` }); continue; }
              // 同一人物归并：AI 若把「デグレチャフ」「ターニャ・デグレチャフ」当成新人物，按名字部件规则归到已有档案；同姓多义则不自动合并
              let mergedInto: string | null = null;
              if (!this.store.knowledge.findByName(seriesId, c.name_jp, batchAt)) {
                const rv = this.store.knowledge.resolveNameVariant(seriesId, c.name_jp, batchAt);
                if (rv.id) { this.store.knowledge.addAlias(rv.id, c.name_jp, 'pre-read', null, batch.map(p => p.id), background.events.map(e => e.id)); mergedInto = rv.id; stats.merged++; this.store.translations.log({ level: 'info', workstationId: 'book-pre-reader', paragraphId: c.evidence_ids[0] ?? null, message: `「${c.name_jp}」按名字规则归并为「${rv.matchedBy}」的别名` }); }
                else if (rv.ambiguous) this.store.translations.log({ level: 'warning', workstationId: 'book-pre-reader', paragraphId: c.evidence_ids[0] ?? null, message: `「${c.name_jp}」可匹配多个已建档人物（同姓/同名），未自动合并，请在人物页手动处理` });
              }
              // 性别守卫：AI 自报的性别必须附带原文证据；无证据、或证据只是名字/职业/外貌 → 一律 unknown（用户要求：严禁从名字猜）
              const g = guardGender(c.gender, c.gender_confidence, c.gender_evidence, c.name_jp);
              if (c.gender !== 'unknown' && g.gender === null) this.store.translations.log({ level: 'warning', workstationId: 'book-pre-reader', paragraphId: c.evidence_ids[0] ?? null, message: `${c.name_jp}：AI 报性别 ${c.gender} 但无有效原文证据（${c.gender_evidence || '空'}），已按 unknown 处理` });
              const fieldEvidence = {
                gender: c.evidence_ids.filter(pid => containsVisibleQuote(batch.find(p => p.id === pid)?.sourceText ?? '', c.gender_evidence)),
                first_person_type: c.field_evidence.filter(e => e.field === 'first_person_type').map(e => e.paragraph_id),
                speech_register: c.field_evidence.filter(e => e.field === 'speech_register').map(e => e.paragraph_id),
                voice_notes: c.field_evidence.filter(e => e.field === 'voice_notes').map(e => e.paragraph_id),
              };
              const id = observeWithConflicts(this.store, { seriesId, introducedVolume: volNo, nameJp: c.name_jp, gender: g.gender, genderConfidence: g.confidence, genderEvidenceIds: g.gender ? c.evidence_ids : [], firstPersonType: c.first_person_type === 'unknown' ? null : c.first_person_type, speechRegister: c.speech_register === 'unknown' ? null : c.speech_register, voiceNotes: c.voice_notes || null }, c.evidence_ids, fieldEvidence, {
                gender: fieldEvidence.gender.map(paragraph_id => ({ paragraph_id, quote: c.gender_evidence })),
                first_person_type: c.field_evidence.filter(e => e.field === 'first_person_type'),
                speech_register: c.field_evidence.filter(e => e.field === 'speech_register'),
                voice_notes: c.field_evidence.filter(e => e.field === 'voice_notes'),
              }, batch.map(p => p.id), background.events.map(e => e.id), c.name_evidence);
              for (const a of c.aliases) {
                if (!a || a === c.name_jp || !batch.some(p => visibleNameSource(p.sourceText).includes(a))) continue;
                // 如果别名已经是另一人物的主名，先给出人工合并提示；不能被安全别名规则静默吞掉。
                const other = this.store.knowledge.findByName(seriesId, a, batchAt);
                if (other && other.id !== id) {
                  const groupKey = `same-person:${[id, other.id].sort().join(':')}`;
                  if (!this.store.translations.hasPending(seriesId, 'warning', groupKey)) this.store.translations.enqueue({ seriesId, kind: 'warning', paragraphId: c.evidence_ids[0] ?? null, groupKey, title: `「${c.name_jp}」与「${other.canonical_name_jp}」疑为同一人物 → 请在人物页手动合并`, payload: { note: `预读认为「${a}」是「${c.name_jp}」的别名，但它已是另一人物「${other.canonical_name_jp}」的档案名。为防误合并，不自动处理；确认是同一人请到人物页详情用「同一人物合并」。`, characterIds: [id, other.id] } });
                  continue;
                }
                // 只有可由主名确定性推导的姓/名/去后缀形式自动入库；昵称、代号、相关实体留人工确认。
                if (!KnowledgeRepo.isSafeAutoAlias(c.name_jp, a)) {
                  const seen = this.store.projects.paragraphsContaining(seriesId, a, 20);
                  if (!KnowledgeRepo.isGenericName(a) && seen.length >= 1) {
                    const groupKey = `unassigned-name:${seriesId}:${a}`;
                    if (!this.store.translations.hasPending(seriesId, 'warning', groupKey)) this.store.translations.enqueue({ seriesId, kind: 'warning', paragraphId: seen[0]!.id, groupKey, title: `原文名字候选「${a}」未归属人物 → 请核对`, payload: { note: `预读模型把「${a}」列为「${c.name_jp}」的别名，但程序无法从名字规则确认；它在原文中出现 ${seen.length} 处，可能是独立人物、代号或称呼。为防人物串线，未自动绑定。请在人物页核对：若是独立人物请新增；若确是同一人可手动添加别名/合并。`, candidateName: a, claimedCharacter: c.name_jp, occurrences: seen.length } });
                  }
                  this.store.translations.log({ level: 'warning', workstationId: 'book-pre-reader', paragraphId: c.evidence_ids[0] ?? null, message: `「${a}」是「${c.name_jp}」的 AI 别名候选，无法由主名确定性推导，未自动写入；如确认是同一人请在人物页手动添加/合并` });
                  continue;
                }
                if (KnowledgeRepo.isGenericName(a)) continue;
                this.store.knowledge.addAlias(id, a, 'pre-read', null, batch.map(p => p.id), background.events.map(e => e.id));
              }
              idOf.set(c.name_jp, id); if (!mergedInto) stats.characters++;
              // Only cited current-batch evidence supports a quirk; never borrow other speakers or future chapters.
              for (const qk of c.quirk_candidates) {
                // AI 常写成「〜のです」「～だぜ」「…であります」：去掉波浪号/省略号/引号后再核对
                const form = qk.trigger_form.replace(/^[〜～~…‥「」『』\s]+|[「」『』\s]+$/g, '').trim(); if (!form) continue;
                const existing = this.store.knowledge.quirks(id);
                if (existing.some(x => x.trigger_form === form)) continue;
                const visibleForm = visibleNameSource(form);
                const evidence = batch.filter(p => qk.evidence_ids.includes(p.id) && p.paragraphType !== 'narration' && containsVisibleQuote(p.sourceText, visibleForm));
                const evid = evidence.map(p => p.id);
                const occ = evidence.reduce((n, p) => n + visibleNameSource(p.sourceText).split(visibleForm).length - 1, 0);
                if (occ < 3 || evid.length < 2) { this.store.translations.log({ level: 'info', workstationId: 'book-pre-reader', message: `${c.name_jp} 语癖候选「${form}」证据不足（所引对话 ${occ} 次、${evid.length} 段），未借用其他段落补证据` }); continue; }
                const groupKey = `quirk:${id}:${form}`;
                if (this.store.translations.hasPending(seriesId, 'quirk-candidate', groupKey)) continue;
                this.store.translations.enqueue({ seriesId, kind: 'quirk-candidate', paragraphId: evid[0]!, groupKey, title: `${c.name_jp} 的「${form}」疑似语癖（所引对话 ${occ} 处）${qk.proposed_pattern ? ` → “${qk.proposed_pattern}”` : ''}`, payload: { characterId: id, characterName: c.name_jp, triggerForm: form, proposedPattern: qk.proposed_pattern || form, signal: 'consistency', occurrences: occ, note: qk.note, evidenceIds: evid, prescan: true } });
                stats.quirks++;
              }
              if (g.gender && g.confidence < 0.8) this.store.translations.enqueue({ seriesId, kind: 'gender-plural', paragraphId: c.evidence_ids[0] ?? null, groupKey: `gender:${id}`, title: `${c.name_jp} 性别推断为 ${g.gender}（${g.confidence.toFixed(2)}）`, payload: { characterId: id, gender: g.gender, confidence: g.confidence, evidence: c.gender_evidence, evidenceIds: c.evidence_ids } });
            }
            const resolve = (name: string): string | null => idOf.get(name) ?? this.store.knowledge.findByName(seriesId, name, batchAt)?.id ?? null;

            // Termination candidates can target only relationships known before
            // this batch's new relationship observations. Same-batch endings need
            // explicit disambiguation, not an inferred predecessor.
            const priorRelationshipIds = new Set(this.store.db.all<{id:string}>('SELECT id FROM relationships WHERE series_id=?',[seriesId]).map(r=>r.id));
            for (const r of out.relationship_events) {
              const a = resolve(r.from_name_jp), b = resolve(r.to_name_jp); if (!a || !b || a === b) continue;
              const recordId = this.store.knowledge.addRelationship({ seriesId, fromCharId: a, toCharId: b, eventType: r.event_type, descriptionJp: r.description_jp, intimacy: r.intimacy_level, respect: r.respect_level, powerDistance: r.power_distance, formality: r.formality_level, validFromPara: r.at_para, evidenceIds: r.evidence_ids });
              bindNarrativeSources(this.store.db, 'relationship', recordId, batch.map(p => p.id), background.events.map(e => e.id)); stats.relationships++;
            }
            for (const e of out.plot_events) {
              const recordId = this.store.knowledge.addEvent({ seriesId, summaryJp: e.summary_jp, atPara: e.at_para, revealsToReader: e.reveals_to_reader, characterIds: e.character_names.map(resolve).filter((x): x is string => !!x), evidenceIds: e.evidence_ids });
              bindNarrativeSources(this.store.db, 'event', recordId, batch.map(p => p.id), background.events.map(e => e.id)); stats.events++;
            }
            const retainedChanges: string[] = [];
            for (const k of out.knowledge_change_candidates) {
              let entityId: string | null | undefined = k.entity_type === 'term' ? this.store.glossary.findTermByJp(seriesId, k.entity_name_jp)?.id : resolve(k.entity_name_jp);
              if (entityId && !['term', 'character'].includes(k.entity_type)) {
                const characterId = entityId;
                const query = k.entity_type === 'relationship'
                  ? 'SELECT id FROM relationships WHERE series_id=? AND (from_char_id=? OR to_char_id=?) AND valid_from_para<? AND (valid_to_para IS NULL OR valid_to_para>?)'
                  : k.entity_type === 'address'
                    ? 'SELECT id FROM address_trajectories WHERE series_id=? AND (speaker_char_id=? OR target_char_id=?) AND valid_from_para<=? AND (valid_to_para IS NULL OR valid_to_para>?)'
                    : 'SELECT id FROM character_states WHERE character_id=? AND valid_from_para<=? AND (valid_to_para IS NULL OR valid_to_para>?)';
                // A newly revealed relationship cannot be its own superseded predecessor.
                const changeAt = k.entity_type === 'relationship' ? Math.max(...batch.filter(p => k.evidence_ids.includes(p.id)).map(p => p.seriesOrdinal)) : batchAt;
                const params = k.entity_type === 'character_state' ? [characterId, batchAt, batchAt] : [seriesId, characterId, characterId, changeAt, changeAt];
                const targets = this.store.db.all<{id: string}>(query, params).filter(row=>k.entity_type!=='relationship'||priorRelationshipIds.has(row.id));
                entityId = targets.length === 1 ? targets[0]!.id : null;
              }
              if (!entityId) {
                this.store.translations.enqueue({ seriesId, kind: 'warning', paragraphId: k.evidence_ids[0] ?? null, groupKey: `change-target:${seriesId}:${k.entity_type}:${k.entity_name_jp}:${batchAt}`, title: `${k.entity_name_jp}：知识变化目标不明确，未停用任何记录`, payload: { note: k.description, entityType: k.entity_type, evidenceIds: k.evidence_ids } });
                continue;
              }
              const cid = this.store.knowledge.addChangeCandidate({ seriesId, entityType: k.entity_type, entityId, changeType: k.change_type, description: k.description, triggeredAtPara: Math.max(...batch.filter(p => k.evidence_ids.includes(p.id)).map(p => p.seriesOrdinal)), evidenceIds: k.evidence_ids }, batch.map(p => p.id), background.events.map(e => e.id));
              retainedChanges.push(cid);
              if (this.store.db.get<{status:string}>('SELECT status FROM knowledge_change_candidates WHERE id=?', [cid])?.status !== 'pending') continue;
              if (this.store.translations.hasPending(seriesId, 'stale-knowledge', `stale:${cid}`)) continue;
              this.store.translations.enqueue({ seriesId, kind: 'stale-knowledge', paragraphId: k.evidence_ids[0] ?? null, groupKey: `stale:${cid}`, title: `${k.entity_name_jp}：${k.description.slice(0, 60)}`, payload: { candidateId: cid, entityType: k.entity_type, entityId, changeType: k.change_type, description: k.description } });
              stats.changes++;
            }
            supersedeChangeCandidates(this.store.db, seriesId, batch.map(p => p.id), retainedChanges);
            checkpoint.save(batch, { before: batch[0]!.seriesOrdinal, background: background.signature, identity: identityInput });
          }));
          processedParagraphs += batch.length;
          this.emit({ detail: detail(), message: `预读「${chapterLabel}」：已核对 ${processedParagraphs}/${paras.length} 段` });
        }
        if (chapterOk) this.store.projects.markPrepDone('preread', ch.id, chapterSource); else failedChapters.push(ch.title ?? `第${ch.chapterNumber}章`);
        this.emit({ done: this.progress.done + 1, message: `预读${chapterOk ? '完成' : '部分失败'}：${ch.title ?? ch.chapterNumber}` });
      }
      const rep = this.store.knowledge.repairGenericNames(seriesId);
      if (rep.promoted.length || rep.deactivated.length || rep.aliasesRemoved) this.store.translations.log({ level: 'info', workstationId: 'book-pre-reader', message: `档案清理：${rep.promoted.length ? `主名修正 ${rep.promoted.join('、')}；` : ''}${rep.deactivated.length ? `无真名档案标记失效 ${rep.deactivated.join('、')}；` : ''}移除代词/职称别名 ${rep.aliasesRemoved} 个` });
      this.emit({ running: false, phase: 'idle', message: `预读完成：人物 ${stats.characters}${stats.merged ? `（归并同名 ${stats.merged}）` : ''}，关系 ${stats.relationships}，事件 ${stats.events}${stats.quirks ? `，语癖候选 ${stats.quirks}` : ''}${failedChapters.length ? `；${failedChapters.length} 章有段落失败（${failedChapters.join('、')}），重新运行只补这些章` : ''}` });
    } catch (e) { this.emit({ running: false, phase: 'idle', message: e instanceof ProviderError && e.kind === 'abort' ? '已停止' : `中断：${(e as Error).message}` }); if (!(e instanceof ProviderError && e.kind === 'abort')) throw e; }
    return stats;
  }

  // ---------------------------------------------------------------- 术语提取 + 译名提案
  async extractTerms(volumeId: string, chapterIds?: string[]): Promise<{ extracted: number; proposed: number }> {
    const seriesId = this.store.projects.getVolumeSeriesId(volumeId);
    const volNo = this.volumeNumberOf(volumeId);
    const chapters = this.store.projects.listChapters(volumeId).filter(c => !chapterIds || chapterIds.includes(c.id));
    const stats = { extracted: 0, proposed: 0 };
    const agg = new Map<string, { term_type: string; sense_identity: string; occ: Set<string>; confidence: number; conflicts: Set<string>; split: string | null }>();
    const splitReceipts: TermSplitReceipt[] = [];
    this.emit({ running: true, phase: '术语提取', done: 0, total: chapters.length + 1, message: '提取术语' });
    const failedChapters: string[] = [];
    const completedChapters: string[] = [];
    const chapterSources = new Map(chapters.map(ch => [ch.id, this.store.projects.chapterSourceSignature(ch.id)]));
    const volumeParagraphs = this.store.projects.listParagraphIdsByVolume(volumeId).map(id => this.store.projects.getParagraph(id)!);
    try {
      this.check();
      reconcileTermCandidates(this.store, volumeId);
      for (const ch of chapters) {
        this.check();
        this.store.projects.clearPrepDone('terms', [ch.id]);
        const paras = this.paragraphsOf(ch.id);
        let chapterOk = true;
        let processedParagraphs = 0;
        const work: typeof paras[] = chunkByChars(paras, Math.min(this.opts.chapterBatchChars ?? 3000, 3000), 32);
        while (work.length) {
          const batch = work.shift()!;
          this.check();
          const existing = this.store.glossary.activeTerms(seriesId).filter(t => t.lock_level !== 'suggested' || !!t.term_zh).map(t => t.term_jp);
          const user = JSON.stringify({ existing, paragraphs: batch.map(p => ({ id: p.id, source: visibleNameSource(p.sourceText) })) });
          try {
            const cached = loadTermExtractionCheckpoint(this.store, user, batch);
            let extracted = cached?.value;
            if (!extracted) {
              let successfulRaw = '';
              const r = await this.ai.structured({ workstation: 'term-extractor', parseRetries: batch.length > 1 ? 0 : 2, user, paragraphId: batch[0]!.id, ...(this.opts.signal ? { signal: this.opts.signal } : {}) }, text => {
                const parsed = parseTermExtract(text, batch);
                if (parsed.ok) successfulRaw = text;
                return parsed;
              });
              this.check();
              extracted = saveTermExtractionCheckpoint(this.store, user, batch, successfulRaw, { aiCallId: r.aiCallId }).value;
            }
            this.check();
            for (const t of extracted.terms) {
              const split = termSplitReceipt(t.split_suggestion);
              if (split) splitReceipts.push(split);
              const a = agg.get(t.term_jp) ?? { term_type: t.term_type, sense_identity: t.sense_identity, occ: new Set<string>(), confidence: t.confidence, conflicts: new Set<string>(), split: t.split_suggestion };
              t.occurrence_paragraph_ids.forEach(id => a.occ.add(id)); t.conflicts.forEach(c => a.conflicts.add(c)); a.confidence = Math.max(a.confidence, t.confidence);
              agg.set(t.term_jp, a);
            }
            processedParagraphs += batch.length;
            this.emit({ detail: { phase: 'terms', label: '术语提取', done: processedParagraphs, total: paras.length, unit: '段', chapterTitle: ch.title ?? `第${ch.chapterNumber}章` }, message: `术语：${ch.title ?? ch.chapterNumber}，已核对 ${processedParagraphs}/${paras.length} 段` });
          } catch (e) {
            if (!(e instanceof AiCallFailed) || e.lastError instanceof ProviderError && !['shape','truncated'].includes(e.lastError.kind)) throw e;
            if (batch.length > 1) { const mid = Math.ceil(batch.length / 2); work.unshift(batch.slice(0, mid), batch.slice(mid)); this.store.translations.log({ level: 'warning', workstationId: 'term-extractor', paragraphId: batch[0]!.id, message: `术语提取块失败（${batch.length} 段）：${e.message}；拆成两半重试` }); continue; }
            chapterOk = false; this.store.translations.log({ level: 'error', workstationId: 'term-extractor', paragraphId: batch[0]!.id, message: `术语提取失败（单段 §${batch[0]!.seriesOrdinal}）：${e.message}` });
          }
        }
        if (chapterOk) completedChapters.push(ch.id); else failedChapters.push(ch.title ?? `第${ch.chapterNumber}章`);
        this.emit({ done: this.progress.done + 1 });
      }

      // A name already independently checked in this volume must not depend on
      // a second free extraction remembering it. It remains an unchosen term
      // candidate and still goes through the existing semantic term selection.
      const volumeIds=new Set(volumeParagraphs.map(p=>p.id));
      for(const person of this.store.knowledge.charactersAt(seriesId,Number.MAX_SAFE_INTEGER)) {
        const name=person.canonical_name_jp;
        if(isHanOnlyTerm(name)||agg.has(name))continue;
        const evidence=this.store.knowledge.reviewedLiteralNameParagraphs(person.id,name).filter(id=>volumeIds.has(id));
        if(evidence.length)agg.set(name,{term_type:'person',sense_identity:'',occ:new Set(evidence),confidence:0.8,conflicts:new Set(),split:null});
      }
      // Preserve evidenced domain candidates; an ungrounded second opinion must not silently delete them.
      this.check();
      this.store.db.transaction(() => {
        for (const [rawJp, a] of agg) {
          const jp = a.term_type === 'person' || a.term_type === 'honorific' ? rawJp.replace(HONORIFIC_SUFFIX_RE, '') : rawJp;
          if (!jp || isHanOnlyTerm(jp) || this.store.glossary.findTermByJp(seriesId, jp)) continue;
          // ========== 原有过滤逻辑（称谓形） ==========

          if (a.term_type === 'person' || a.term_type === 'honorific') {
            // 「田中さん」「高坂さん」这类带称谓后缀的形式不是术语：由称谓体系（④）处理；代词/职称也不是
            const namedPerson = a.term_type === 'person' ? this.store.knowledge.findByName(seriesId,jp) : null;
            if (KnowledgeRepo.isGenericName(jp) && !(namedPerson && namedPerson.canonical_name_jp===jp && this.store.knowledge.hasReviewedLiteralName(namedPerson.id,jp))) { this.store.translations.log({ level: 'info', workstationId: 'term-extractor', message: `「${jp}」是称谓形/代词，不作为术语（人名由人物档案+称谓体系处理）` }); continue; }
          }
          // 程序补全出现位置（模型只给样本）
          const occ = new Set(a.occ); for (const p of volumeParagraphs.filter(p => containsVisibleQuote(p.sourceText, jp))) occ.add(p.id);
          this.store.glossary.upsertTerm({ seriesId, introducedVolume: volNo, termJp: jp, termZh: null, termType: a.term_type, senseIdentity: a.sense_identity || null, lockLevel: 'suggested', confidence: a.confidence, evidenceIds: [...occ].slice(0, 20), notes: a.conflicts.size ? `冲突：${[...a.conflicts].join('；')}` : null });
          stats.extracted++;
        }
        reconcileTermCandidates(this.store, volumeId, splitReceipts);

      });
      this.emit({ phase: '术语筛选', message: '筛除普通词，整理需要确认的名称与概念' });
      await selectTermCandidates(this.store, this.ai, volumeId, this.opts.signal);
      this.store.transaction(() => { for (const chapterId of completedChapters) this.store.projects.markPrepDone('terms', chapterId, chapterSources.get(chapterId)); });
      // 译名提案：对所有无译名的 suggested 术语分批
      const pending = missingTermProposals(this.store, volumeId);
      let completedProposals = 0;
      this.emit({ phase: '术语译名提案', detail: { phase: 'terms', label: '准备候选译名', done: completedProposals, total: pending.length, unit: '项' }, message: `术语译名提案：已完成 ${completedProposals}/${pending.length} 项` });
      for (let i = 0; i < pending.length; i += 3) {
        this.check();
        const batch = pending.slice(i, i + 3);
        const style = this.store.projects.getSettings(seriesId)['honorific.default_style'];
        const known = this.store.glossary.activeTerms(seriesId).filter(t => t.term_zh && t.lock_level !== 'suggested').map(t => `${t.term_jp}→${t.term_zh}`).join('、');
        // 同一人物的全名/姓/名分组：要求译名一致（久美子 的译名必须是 黄前久美子 译名的一部分）
        const groups: string[] = [];
        for (const t of batch) {
          if (t.term_type !== 'person') continue;
          const c = this.store.knowledge.findByName(seriesId, t.term_jp);
          if (!c) continue;
          const forms = [c.canonical_name_jp, ...this.store.knowledge.aliasesOf(c.id)].filter(n => !KnowledgeRepo.isGenericName(n));
          if (forms.length > 1) { const g = `${forms.join(' / ')}${c.canonical_name_zh ? `（已确认中文名：${c.canonical_name_zh}）` : ''}`; if (!groups.includes(g)) groups.push(g); }
        }
        const contexts = new Map(batch.map(t => [t.term_jp, termProposalContext(volumeParagraphs, t.term_jp)]));
        const examples = (jp: string) => contexts.get(jp)!.examples;
        const scopedExamples = batch.flatMap(t => examples(t.term_jp));
        const user = JSON.stringify({ confirmed_names: known, honorific_style: style, name_groups: groups,
          terms: batch.map(t => ({ term_jp: t.term_jp, term_type: t.term_type, sense_identity: t.sense_identity, background: contexts.get(t.term_jp)!.background,
            examples: examples(t.term_jp).map(p => ({ id: p.id, source: visibleNameSource(p.sourceText) })) })) });
        try {
          const r = await this.ai.structured({ workstation: 'term-translation-proposer', user, ...(this.opts.signal ? { signal: this.opts.signal } : {}) }, text => parseTermProposal(text, batch.map(t => t.term_jp), scopedExamples));
          this.check();
          for (const p of r.value.proposals) {
            const term = batch.find(t => t.term_jp === p.term_jp); if (!term) continue;
            const ex = examples(term.term_jp);
            this.store.translations.enqueue({ seriesId, kind: 'term-proposal', paragraphId: ex[0]?.id ?? null, groupKey: `term:${term.id}`, title: `「${p.term_jp}」→ ${p.candidates.map(c => c.zh).join(' / ')}`, payload: { termId: term.id, termJp: p.term_jp, termType: term.term_type, candidates: p.candidates, variants: p.variants, annotation: p.annotation_draft, proposalBackground: contexts.get(p.term_jp)!.background, examples: ex.map(x => ({ id: x.id, text: x.sourceText })) } });
            stats.proposed++;
          }
          completedProposals += batch.length;
          this.emit({ detail: { phase: 'terms', label: '准备候选译名', done: completedProposals, total: pending.length, unit: '项' }, message: `术语译名提案：已完成 ${completedProposals}/${pending.length} 项` });
        } catch (e) { if (e instanceof AiCallFailed) this.store.translations.log({ level: 'error', workstationId: 'term-translation-proposer', message: `译名提案失败：${e.message}` }); else throw e; }
      }
      const proposalsRemaining = missingTermProposals(this.store, volumeId).length;
      this.emit({ running: false, phase: 'idle', done: this.progress.total, message: `提取 ${stats.extracted} 个新术语，提案 ${stats.proposed} 个${proposalsRemaining ? `；${proposalsRemaining} 项提案仍待补做，可继续` : ''}${failedChapters.length ? `；${failedChapters.length} 章有段落失败（${failedChapters.join('、')}），重新运行只补这些章` : ''}` });
    } catch (e) { this.emit({ running: false, phase: 'idle', message: e instanceof ProviderError && e.kind === 'abort' ? '已停止' : `中断：${(e as Error).message}` }); if (!(e instanceof ProviderError && e.kind === 'abort')) throw e; }
    return stats;
  }

  // ---------------------------------------------------------------- 场景分析
  async analyzeScenes(paragraphIds: string[]): Promise<number> {
    const paras = paragraphIds.map(id => this.store.projects.getParagraph(id)!).filter(Boolean);
    const scenes = new Map<string, typeof paras>();
    for (const p of paras) { const a = scenes.get(p.sceneId) ?? []; a.push(p); scenes.set(p.sceneId, a); }
    let n = 0; let failed = 0;
    const totalScenes = scenes.size; let startedScenes = 0;
    this.emit({ running: true, phase: '场景分析', done: 0, total: paras.length, message: `${totalScenes} 个场景，${paras.length} 段` });
    // 一块 = 一次 AI 调用。失败则二分拆块重试（直到单段），一次坏输出不会让整个场景归零；单段仍失败才计入 failed。
    const analyzeBatch = async (batch: typeof paras, label: string): Promise<void> => {
      this.check();
      const ids = batch.map(p => p.id);
      this.emit({ message: `${label}：§${batch[0]!.seriesOrdinal}–§${batch[batch.length - 1]!.seriesOrdinal}，${batch.length} 段…`, currentParagraphId: ids[0]! });
      const pack = buildContextPack(this.store, { paragraphIds: ids, workstation: 'scene-analyst', windowBefore: 4, windowAfter: 2, sourceOnlyWindow: true });
      const seriesId = pack.seriesId;
      const sourceContextIds = [...new Set([...ids, ...(pack.sourceContextIds ?? []), ...sceneNameCandidateSourceIds(this.store, ids)])];
      const expectedSourceSignature = this.store.projects.sceneContextSignature(sourceContextIds);
      const expectedIdentitySignature = this.store.projects.sceneIdentitySignature(sourceContextIds);
      const nameChoices = sceneNameCandidates(this.store, ids, pack.sourceContextIds ?? []);
      const chars = JSON.stringify(nameChoices);
      const user = `${pack.text}\n\n【各段可选姓名 ID】这些只是该段当时可知的姓名，不证明在场或说话人；单字可能是普通词，须用原文判断。仅使用对应paragraph_id的candidates，不能借用其他段的候选。名字字段用日文原名。${chars || '（无）'}\n\n【本次任务块】（id 必须原样、完整返回；speaker_char_id 只能用上面的 ID 或 null）\n${JSON.stringify({ items: batch.map(p => ({ id: p.id, type: p.paragraphType, source: p.sourceText })) })}`;
      try {
        const r = await this.ai.structured({ workstation: 'scene-analyst', parseRetries: batch.length > 1 ? 0 : 2, user, paragraphId: ids[0]!, ...(this.opts.signal ? { signal: this.opts.signal } : {}) }, text => parseScene(text, ids));
        this.check();
        if (batch.some(p => {
          const live = this.store.projects.getParagraph(p.id);
          return !live || live.sourceText !== p.sourceText || live.seriesOrdinal !== p.seriesOrdinal || live.chapterId !== p.chapterId || live.paragraphType !== p.paragraphType;
        })) throw new Error('场景原文在分析期间已变化，请重试。');
        const livePack = buildContextPack(this.store, { paragraphIds: ids, workstation: 'scene-analyst', windowBefore: 4, windowAfter: 2, sourceOnlyWindow: true });
        if (this.store.projects.sceneContextSignature(sourceContextIds) !== expectedSourceSignature) throw new Error('场景原文背景依据在分析期间已变化，请重试。');
        if (livePack.text !== pack.text || JSON.stringify(livePack.presentCharacterIds) !== JSON.stringify(pack.presentCharacterIds)) throw new Error('场景原文背景或人物范围在分析期间已变化，请重试。');
        if (JSON.stringify(sceneNameCandidates(this.store, ids, pack.sourceContextIds ?? [])) !== JSON.stringify(nameChoices)) throw new Error('场景姓名依据在分析期间已变化，请重试。');
        // One synchronous atomic commit writes only scene analysis and its meta
        // receipts. Name resolution reads knowledge; share those unchanged proofs
        // inside the commit, never across the model await or a later batch.
        this.store.transaction(() => withIdentityRead(this.store.db, () => {
        for (const a of r.value.paragraphs) {
          const valid = new Set(nameChoices.find(choice => choice.paragraph_id === a.id)!.candidates.map(c => c.id));
          // 锚定说话人：优先 speaker_char_id；否则按名字双向解析（日文名→权威中文名，或中文名反查回日文原名），保证说话人一定能绑到标准角色
          let spk = a.speaker_char_id && valid.has(a.speaker_char_id) ? a.speaker_char_id : null;
          if (!spk && a.speaker_name) {
            const resolved = resolveEntityNameBidirectional(this.store, seriesId, a.speaker_name);
            if (resolved.id && valid.has(resolved.id)) spk = resolved.id;
          }
          // 受话人/在场者：同样按名锚定后合并到 ID 列表
          const anchorIds = (names: string[]): string[] => {
            const out = new Set<string>();
            for (const nm of names) { if (valid.has(nm)) out.add(nm); else { const rr = resolveEntityNameBidirectional(this.store, seriesId, nm); if (rr.id && valid.has(rr.id)) out.add(rr.id); } }
            return [...out];
          };
          this.store.projects.saveAnalysis({ paragraphId: a.id, speakerCharId: spk, speakerConfidence: a.speaker_confidence, targetCharIds: anchorIds(a.target_char_ids), presentCharIds: anchorIds(a.present_char_ids), intent: a.intent, difficultyFlags: a.difficulty_flags, evidenceIds: a.evidence_ids, sceneBoundaryBefore: a.scene_boundary_before, atmosphere: a.atmosphere, sourceContextIds, expectedIdentitySignature });
        }
        }));
        n += r.value.paragraphs.length;
        this.emit({ done: this.progress.done + batch.length, currentParagraphId: ids[ids.length - 1]!, message: `${label} 完成，已分析 ${n}/${paras.length} 段` });
      } catch (e) {
        if (!(e instanceof AiCallFailed) || e.lastError instanceof ProviderError && !['shape', 'truncated'].includes(e.lastError.kind)) throw e;
        if (batch.length > 1) {
          this.store.translations.log({ level: 'warning', workstationId: 'scene-analyst', paragraphId: ids[0]!, message: `场景分析块失败（${batch.length} 段）：${e.message}；拆成两半重试` });
          const mid = Math.ceil(batch.length / 2);
          await analyzeBatch(batch.slice(0, mid), `${label}·前半`);
          await analyzeBatch(batch.slice(mid), `${label}·后半`);
        } else {
          failed++;
          this.store.translations.log({ level: 'error', workstationId: 'scene-analyst', paragraphId: ids[0]!, message: `场景分析失败（单段 §${batch[0]!.seriesOrdinal}）：${e.message}` });
          this.emit({ done: this.progress.done + 1 });
        }
      }
    };
    try {
      const queue = [...scenes.values()];
      const workers = Math.max(1, Math.min(this.ai.config.concurrency, queue.length));
      const settled = await Promise.allSettled(Array.from({ length: workers }, async () => {
        for (;;) {
          const scene = queue.shift(); if (!scene) return;
          const sceneNo = ++startedScenes;
          // 每块较小（3000 字）：进度条更细、失败重试范围更小
          const chunks = chunkByChars(scene, 3000, 32);
          for (let ci = 0; ci < chunks.length; ci++) await analyzeBatch(chunks[ci]!, `分析场景 ${sceneNo}/${totalScenes}${chunks.length > 1 ? `（第 ${ci + 1}/${chunks.length} 块）` : ''}`);
        }
      }));
      const rejected = settled.find(r => r.status === 'rejected');
      if (rejected?.status === 'rejected') throw rejected.reason;
      this.emit({ running: false, phase: 'idle', message: `场景分析完成 ${n} 段${failed ? `，${failed} 段失败（见任务日志，可重新运行本步只补失败段）` : ''}` });
    } catch (e) { this.emit({ running: false, phase: 'idle', message: e instanceof ProviderError && e.kind === 'abort' ? '已停止' : `中断：${(e as Error).message}` }); if (!(e instanceof ProviderError && e.kind === 'abort')) throw e; }
    return n;
  }

  // ---------------------------------------------------------------- 称谓预扫描（预处理 ④，可选）
  /**
   * 翻译前扫出全册"说话人→受话人「称呼形式」"组合，入复核队列并让 AI 生成候选 + 推荐，**预选不锁定**。
   * 依赖：③ 场景分析（说话人）+ ① 人物档案（名字/别名）。规则层只做确定性匹配，保证不引入 AI 幻觉的组合：
   *  - 只扫对话/混合段中「」内的文本；
   *  - 形式 = 已建档名字/别名 + 称谓后缀（さん/ちゃん/君/様/先輩/军衔…），或呼び捨て（裸名后紧跟标点/引号末）；
   *  - 说话人必须由场景分析识别，受话人必须解析到档案人物，二者不同；已由用户锁定的组合跳过。
   */
  async prescanHonorifics(volumeId: string): Promise<{ forms: number; enqueued: number; candidates: number; skippedNoSpeaker: number; alreadyLocked: number }> {
    const seriesId = this.store.projects.getVolumeSeriesId(volumeId);
    const stats = { forms: 0, enqueued: 0, candidates: 0, skippedNoSpeaker: 0, alreadyLocked: 0 };
    const pids = this.store.projects.listParagraphIdsByVolume(volumeId);
    const analyses = this.store.projects.analysesFor(pids);
    const chars = this.store.knowledge.listCharacters(seriesId).filter(c => c.is_active);
    // 名字/别名 → 人物 id；长名优先，避免「ターニャ」吞掉「ターニャ・デグレチャフ」
    const names: { name: string; id: string }[] = [];
    for (const c of chars) { names.push({ name: c.canonical_name_jp, id: c.id }); for (const a of this.store.knowledge.aliasesOf(c.id)) if (a.length >= 2) names.push({ name: a, id: c.id }); }
    names.sort((a, b) => b.name.length - a.name.length);
    const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const SUFFIX = '(?:さん|ちゃん|くん|君|様|さま|先輩|せんぱい|先生|せんせい|殿|どの|氏|たん|嬢|卿|閣下|陛下|隊長|部長|会長|社長|中尉|大尉|少尉|准尉|少佐|中佐|大佐|少将|中将|大将|元帥|軍曹|伍長|曹長|博士|教授|お姉ちゃん|お兄ちゃん|姉さん|兄さん|姐さん)';
    const VOCATIVE_END = '(?=[、。！？!?…‥，,\\s]|$)';
    this.emit({ running: true, phase: '称谓预扫描', done: 0, total: pids.length, message: `扫描 ${pids.length} 段对话中的称呼…` });
    // key = spk|tgt|form → 首次出现段 + 次数
    const found = new Map<string, { spk: string; tgt: string; form: string; firstPid: string; firstAt: number; count: number }>();
    try {
      let i = 0;
      for (const pid of pids) {
        if (i % 32 === 0) {
          await new Promise<void>(resolve => setTimeout(resolve, 0));
          this.check();
        }
        i++;
        if (i % 50 === 0) this.emit({ done: i, message: `扫描称呼 ${i}/${pids.length} 段，已发现 ${found.size} 组` });
        const p = this.store.projects.getParagraph(pid); if (!p || p.paragraphType === 'narration') continue;
        const quotes = [...p.sourceText.matchAll(/「([^」]*)」/g)].map(m => m[1]!);
        if (!quotes.length) continue;
        const a = analyses.get(pid);
        const spk = a?.speaker_char_id ?? null;
        for (const qt of quotes) {
          let rest = qt;
          for (const nm of names) {
            if (!rest.includes(nm.name)) continue;
            const owner = this.store.knowledge.getCharacter(nm.id);
            if (!owner || !this.store.knowledge.nameCurrent(owner, p.seriesOrdinal) || (nm.name !== owner.canonical_name_jp && !this.store.knowledge.aliasesAt(nm.id, p.seriesOrdinal).includes(nm.name))) continue;
            const re = new RegExp(`${esc(nm.name)}(?:${SUFFIX}|${VOCATIVE_END})`, 'g');
            for (const m of rest.matchAll(re)) {
              const form = m[0].replace(/[、。！？!?…‥，,\s]+$/, '');
              if (!spk) { stats.skippedNoSpeaker++; continue; }
              if (spk === nm.id) continue; // 自称不算称呼
              const key = `${spk}|${nm.id}|${form}`;
              const cur = found.get(key);
              if (cur) cur.count++; else found.set(key, { spk, tgt: nm.id, form, firstPid: pid, firstAt: p.seriesOrdinal, count: 1 });
            }
            rest = rest.replace(re, ' '); // 已匹配的长名不再被短名重复匹配
          }
        }
      }
      stats.forms = found.size;
      // 入队（跳过已锁定的）
      const newIds: string[] = [];
      for (const f of found.values()) {
        this.check();
        if (this.store.knowledge.isAddressAdopted(this.store.knowledge.activeAddress(seriesId, f.spk, f.tgt, f.form, f.firstAt))) { stats.alreadyLocked++; continue; }
        const nm = (id: string): string => { const c = this.store.knowledge.getCharacter(id); return c?.canonical_name_zh ?? c?.canonical_name_jp ?? id; };
        const groupKey = `honorific:${f.spk}:${f.tgt}:${f.form}`;
        const existed = this.store.translations.hasPending(seriesId, 'honorific-first', groupKey);
        const qid = this.store.translations.enqueue({ seriesId, kind: 'honorific-first', paragraphId: f.firstPid, groupKey, title: `${nm(f.spk)} → ${nm(f.tgt)}：「${f.form}」（全册 ${f.count} 处）`, payload: { speakerCharId: f.spk, targetCharId: f.tgt, speakerName: nm(f.spk), targetName: nm(f.tgt), sourceFormJp: f.form, usedZh: null, occurrences: f.count, prescan: true } });
        if (!existed) { stats.enqueued++; newIds.push(qid); }
        else if (!('candidates' in (this.store.translations.getQueueItem(qid)?.payload ?? {}))) newIds.push(qid);
      }
      // AI 生成候选 + 推荐，预选（不锁定）
      this.emit({ phase: '称谓预扫描', done: 0, total: newIds.length, message: `为 ${newIds.length} 组称呼生成中文候选…` });
      const queue = [...newIds];
      const workers = Math.max(1, Math.min(this.ai.config.concurrency, queue.length || 1));
      await Promise.all(Array.from({ length: workers }, async () => {
        for (;;) {
          const qid = queue.shift(); if (!qid) return;
          this.check();
          const cur = this.store.translations.getQueueItem(qid);
          const cpl = cur?.payload as { sourceFormJp: string; targetCharId: string | null } | undefined;
          // 裸名（呼び捨て）：译法就是该名字的中文名，确定性生成，不调 AI
          if (cpl && !HONORIFIC_SUFFIX_RE.test(cpl.sourceFormJp)) {
            const bare = bestZhName(this.store, seriesId, cpl.sourceFormJp);
            if (bare.zh && !hasKana(bare.zh)) {
              this.store.translations.updateQueuePayload(qid, { ...cur!.payload, candidates: [{ zh: bare.zh, register: 'neutral', rationale: `呼び捨て：直接用该名字的中文名${bare.tentative ? '（译名待确认）' : ''}` }], recommended: bare.zh, relationStage: '呼び捨て', preSelected: bare.zh, preSelectedBasis: bare.tentative ? '中文名（待确认）' : '中文名' });
              stats.candidates++;
              this.emit({ done: this.progress.done + 1, message: `候选生成 ${this.progress.done + 1}/${newIds.length}` });
              continue;
            }
          }
          const ok = await this.resolveHonorific(qid);
          if (ok) {
            stats.candidates++;
            const it = this.store.translations.getQueueItem(qid);
            const pl = it?.payload as Record<string, unknown> | undefined;
            if (pl && typeof pl.recommended === 'string' && pl.recommended && !pl.preSelected) this.store.translations.updateQueuePayload(qid, { ...pl, preSelected: pl.recommended, preSelectedBasis: 'AI 推荐' });
          }
          this.emit({ done: this.progress.done + 1, message: `候选生成 ${this.progress.done + 1}/${newIds.length}` });
        }
      }));
      this.emit({ running: false, phase: 'idle', message: `称谓预扫描完成：${stats.forms} 组称呼，新入队 ${stats.enqueued}，候选 ${stats.candidates}${stats.alreadyLocked ? `，已锁定 ${stats.alreadyLocked} 跳过` : ''}${stats.skippedNoSpeaker ? `，${stats.skippedNoSpeaker} 处说话人未识别跳过` : ''}` });
    } catch (e) { this.emit({ running: false, phase: 'idle', message: e instanceof ProviderError && e.kind === 'abort' ? '已停止' : `中断：${(e as Error).message}` }); if (!(e instanceof ProviderError && e.kind === 'abort')) throw e; }
    return stats;
  }

  // ---------------------------------------------------------------- 称谓解析（按队列项）
  /** 为一个 honorific-first 队列项生成候选并写回 payload.candidates */
  async resolveHonorific(queueItemId: string): Promise<boolean> {
    const item = this.store.translations.getQueueItem(queueItemId); if (!item || item.kind !== 'honorific-first' || !item.paragraph_id) return false;
    const pl = item.payload as { speakerCharId: string | null; targetCharId: string | null; speakerName: string; targetName: string; sourceFormJp: string; usedZh: string | null };
    const paragraphId = item.paragraph_id;
    const captureInput = () => {
    const pack = buildContextPack(this.store, { paragraphIds: [paragraphId], workstation: 'honorific-resolver', windowBefore: 6, windowAfter: 3 });
    const seriesId = pack.seriesId;
    const style = this.store.projects.getSettings(seriesId)['honorific.default_style'];
    const same = this.store.knowledge.anyAddressForForm(seriesId, pl.sourceFormJp).filter(a => this.store.knowledge.isAddressAdopted(a) && a.speaker_char_id === pl.speakerCharId && a.target_char_id === pl.targetCharId && a.valid_from_para <= pack.atPara && (a.valid_to_para == null || a.valid_to_para > pack.atPara)).map(a => a.translated_form);
    const styleKey: 'loan' | 'native' = style === 'loan' ? 'loan' : 'native';
    // 受话人/说话人的中文名（已确认或提案预选）：AI 候选必须基于它，禁止把假名/日文汉字留在中文里
    const targetJp = pl.targetCharId ? this.store.knowledge.getCharacter(pl.targetCharId)?.canonical_name_jp ?? pl.targetName : pl.targetName;
    const speakerJp = pl.speakerCharId ? this.store.knowledge.getCharacter(pl.speakerCharId)?.canonical_name_jp ?? pl.speakerName : pl.speakerName;
    const tZh = bestZhName(this.store, seriesId, targetJp), sZh = bestZhName(this.store, seriesId, speakerJp);
    const baseJp = pl.sourceFormJp.replace(HONORIFIC_SUFFIX_RE, '');
    const baseZh = baseJp !== pl.sourceFormJp || baseJp !== targetJp ? bestZhName(this.store, seriesId, baseJp) : tZh; // 形式里用的可能是昵称/姓/名
    const deterministic = renderAddressForm(this.store, seriesId, pl.sourceFormJp, styleKey);
    const nameHint = tZh.zh ? `【受话人中文名】${tZh.zh}${tZh.tentative ? '（术语提案候选，尚未确认，仍须以此为准）' : ''}${baseZh.zh && baseZh.zh !== tZh.zh ? `；本称呼形中所用名字部分「${baseJp}」的中文为「${baseZh.zh}」` : ''}` : `【受话人中文名】尚无——请给出音译/常用译名，禁止保留假名`;
    const user = `${pack.text}\n\n【待解析称谓】说话人=${pl.speakerName}${sZh.zh ? `（中文名 ${sZh.zh}）` : ''}(id=${pl.speakerCharId ?? 'null'}) → 受话人=${pl.targetName}(id=${pl.targetCharId ?? 'null'})；原文形式「${pl.sourceFormJp}」${pl.usedZh ? `；初译“${pl.usedZh}”` : ''}\n${nameHint}\n【硬规则】候选必须是纯中文：名字部分必须使用上面给出的中文名（不得保留平假名/片假名，不得使用日文汉字写法如「葉」「麗」，要用中文简体「叶」「丽」）；只有后缀/称谓词的译法可以变化。\n【项目默认风格】${style === 'loan' ? '借用式（桑/酱/君/大人）' : '按人物关系与场景译成中文，不能固定套同学或先生'}\n【同一说话人→受话人在本处关系阶段的已确认译法（跨章沿用，不能借其他人物称呼覆盖）】${same.length ? [...new Set(same)].join('、') : '（无）'}`;
    const source = this.store.projects.getParagraph(paragraphId);
    if (!source) throw new Error('段落已不存在');
    const evidenceSources = [paragraphId, ...(pack.sourceContextIds ?? [])].filter((id, i, all) => all.indexOf(id) === i).map(id => this.store.projects.getParagraph(id)).filter((p): p is NonNullable<typeof p> => !!p);
    return { user: `${user}\n\n【本次称谓所在原文】\n[${paragraphId}] ${source.sourceText}\n【可引用的原文依据】\n${evidenceSources.map(p => `[${p.id}] ${p.sourceText}`).join('\n')}`, evidenceSources: evidenceSources.map(p => ({id:p.id,source:p.sourceText})), baseJp, baseZh, targetJp, tZh, deterministic };
    };
    const captured = captureInput();
    const { user, baseJp, baseZh, targetJp, tZh, deterministic } = captured;
    try {
      const r = await this.ai.structured({ workstation: 'honorific-resolver', user, paragraphId, ...(this.opts.signal ? { signal: this.opts.signal } : {}) }, parseHonorific);
      this.check();
      const current = this.store.translations.getQueueItem(queueItemId);
      if (!current || current.status !== item.status || current.paragraph_id !== paragraphId || JSON.stringify(current.payload) !== JSON.stringify(item.payload)
        || JSON.stringify(captureInput()) !== JSON.stringify(captured)) throw new Error('原文、人物译名或称谓依据已变化，本次候选未保存，请重新生成');
      if (!r.value.evidence_ids.length || r.value.evidence_ids.some(id => !captured.evidenceSources.some(p => p.id === id))) {
        this.store.translations.log({level:'warning',workstationId:'honorific-resolver',paragraphId,message:'称呼候选引用了未提供的原文，未保存，请重新核对'});return false;
      }
      // 候选守卫：夹假名的候选先尝试用中文名替换名字部分；仍有假名 → 丢弃。始终补入确定性候选保证可用。
      const fixName = (zh: string): string => { let out = zh; for (const [jp, cn] of [[baseJp, baseZh.zh], [targetJp, tZh.zh]] as const) if (jp && cn && out.includes(jp)) out = out.split(jp).join(cn); if (baseZh.zh && tZh.zh && baseZh.zh !== tZh.zh && out.includes(tZh.zh)) out = out.split(tZh.zh).join(baseZh.zh); /* 形式只用了姓/名，候选却写了全名 → 换回部件 */ return out; };
      const seen = new Set<string>();
      const cands: { zh: string; register: 'intimate' | 'neutral' | 'formal' | 'mocking'; rationale: string }[] = [];
      for (const c of r.value.candidates) { const zh = fixName(c.zh).trim(); if (!zh || hasKana(zh) || seen.has(zh)) continue; seen.add(zh); cands.push({ ...c, zh }); }
      if (deterministic && !seen.has(deterministic.zh)) { cands.push({ zh: deterministic.zh, register: 'neutral', rationale: `系统按${deterministic.basis}生成` }); seen.add(deterministic.zh); }
      if (!cands.length) { this.store.translations.log({ level: 'warning', workstationId: 'honorific-resolver', paragraphId: item.paragraph_id, message: `「${pl.sourceFormJp}」的候选全部含假名且受话人尚无中文名，请先确认人名译名再运行称谓解析` }); return false; }
      const contextUncertain = this.store.projects.getSettings(item.series_id)['honorific.default_style'] === 'native' && (!pl.speakerCharId || !pl.targetCharId || /^(unknown|uncertain|不明|未知|未确定|不确定)?$/i.test(r.value.relation_stage.trim()));
      let recommended = fixName(r.value.recommended).trim();
      if (!seen.has(recommended)) recommended = cands[0]!.zh;
      this.store.translations.updateQueuePayload(queueItemId, { ...item.payload, candidates: cands, recommended: contextUncertain ? '' : recommended, needsContextConfirmation: contextUncertain, ...(contextUncertain ? { preSelected: null, preSelectedBasis: null, aiRecommendation: null } : {}), relationStage: contextUncertain ? '人物关系尚未确定，请结合原文确认' : r.value.relation_stage, evidenceIds: r.value.evidence_ids, evidenceSources: captured.evidenceSources.filter(p => r.value.evidence_ids.includes(p.id)), targetZh: tZh.zh, targetZhTentative: tZh.tentative });
      return true;
    } catch (e) { if (e instanceof AiCallFailed) { this.store.translations.log({ level: 'error', workstationId: 'honorific-resolver', paragraphId: item.paragraph_id, message: `称谓解析失败：${e.message}` }); return false; } throw e; }
  }
  async resolveAllPendingHonorifics(seriesId: string): Promise<number> {
    const items = this.store.translations.listPendingByKind(seriesId, 'honorific-first').filter(i => !('candidates' in i.payload));
    let n = 0;
    this.emit({ running: true, phase: '称谓解析', done: 0, total: items.length, message: `${items.length} 个称谓待解析` });
    for (const it of items) { this.check(); if (await this.resolveHonorific(it.id)) n++; this.emit({ done: this.progress.done + 1 }); }
    this.emit({ running: false, phase: 'idle', message: `称谓解析完成 ${n}` });
    return n;
  }
}
