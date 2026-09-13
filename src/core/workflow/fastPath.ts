/**
 * 快速路径判定（docs/设计/REVIEW_ROUTING.md 第 2 节）。同时满足全部条件的段落跳过 AI 审校，只保留程序校验与中文编辑。
 */
import type { FastPathMode, ParagraphType, TranslationFlag, ToneAxes, SourceCoverageItem } from '@shared/types';
import type { AnalysisRow } from '@core/db';
import { fromJson } from '@core/db';
import type { GlossaryHitDetail } from '@core/glossary/hits';

export interface FastPathInput {
  mode: FastPathMode;
  paragraphType: ParagraphType;
  analysis: AnalysisRow | undefined;
  /** 宽松入参：zod 输出的 coverage 里 ord 可能是 number|undefined */
  sourceCoverage: readonly Pick<SourceCoverageItem, 'segment' | 'rendered_as' | 'status' | 'ord'>[];
  toneAxes: ToneAxes | undefined;
  flags: readonly TranslationFlag[];
  glossaryHits: readonly GlossaryHitDetail[];
  source: string;
  hasUnconfirmedCandidatesForPresentCharacters: boolean;
}
export interface FastPathDecision { eligible: boolean; reasons: string[] }

const HONORIFIC_RE = /[一-龯ぁ-ゖァ-ヺA-Za-z・ー]{1,12}(さん|ちゃん|くん|君|様|さま|殿|氏|先輩|先生|閣下)(?![一-龯ぁ-ゖ])/u;
const NEGATION_RISK_RE = /(どころか|まさか|わけがない|わけではない|はずがない|ものか|なくはない|ないことはない|とは限らない)/u;
const NUMBER_RE = /[0-9０-９]|[〇零一二三四五六七八九十百千万億]+(?=[人つ個本枚匹回度年月日時分秒番歳才階名台冊巻章話])/u;
const GENDER_RE = /(彼女|彼(?![女らたち達等])|少女|少年|娘|息子|女|男)/u;
const PLURAL_RE = /(たち|達|ら(?![れし])|人々|方々|諸君|一同|皆|みんな)/u;
const QUIRK_SIGNAL_RE = /(のです|なのです|のだ(?=[。！？」』]|$)|のじゃ|っス|ッス|にゃ|ですわ|ですの|だぜ|でござる|〜|～|♥|♡)/u;

export function decideFastPath(i: FastPathInput): FastPathDecision {
  const reasons: string[] = [];
  if (i.mode === 'off') return { eligible: false, reasons: ['快速路径已关闭'] };
  const aggressive = i.mode === 'aggressive';

  // 1. 叙述，或对话但说话人置信度高且在场 ≤ 2
  if (i.paragraphType !== 'narration') {
    if (!aggressive) {
      const conf = i.analysis?.speaker_confidence ?? 0;
      const present = fromJson<string[]>(i.analysis?.present_char_ids, []).length;
      if (conf < 0.9) reasons.push(`对话段说话人置信度 ${conf.toFixed(2)} < 0.9`);
      if (present > 2) reasons.push(`在场人物 ${present} > 2`);
    }
  }
  // 2. 源文覆盖无 uncertain
  if (i.sourceCoverage.some(c => c.status === 'uncertain')) reasons.push('源文覆盖存在 uncertain');
  // 3. 无难点信号
  const flags = fromJson<string[]>(i.analysis?.difficulty_flags, []);
  if (flags.length) reasons.push(`场景分析难点：${flags.join(',')}`);
  if (i.flags.length) reasons.push(`初译 flags：${i.flags.map(f => f.type).join(',')}`);
  if (i.glossaryHits.length) reasons.push('命中术语表条目');
  if (HONORIFIC_RE.test(i.source)) reasons.push('含称呼后缀');
  if (NUMBER_RE.test(i.source)) reasons.push('含数字');
  if (GENDER_RE.test(i.source)) reasons.push('含性别词');
  if (PLURAL_RE.test(i.source)) reasons.push('含复数标记');
  if (NEGATION_RISK_RE.test(i.source)) reasons.push('含否定/反转风险句式');
  if (i.paragraphType !== 'narration' && QUIRK_SIGNAL_RE.test(i.source)) reasons.push('含疑似语癖信号');
  // 4. 七轴 0–1 且无 unknown
  if (!aggressive) {
    if (!i.toneAxes) reasons.push('缺少七轴自评');
    else for (const [k, v] of Object.entries(i.toneAxes)) { if (v === 'unknown') { reasons.push(`七轴 ${k}=unknown`); break; } if (v > 1) { reasons.push(`七轴 ${k}=${v} > 1`); break; } }
  }
  // 5. 人物无未确认候选
  if (i.hasUnconfirmedCandidatesForPresentCharacters) reasons.push('在场人物存在未确认候选');
  return { eligible: reasons.length === 0, reasons };
}

/** 抽样审计：每 20 段快速路径段落随机抽 1 段跑完整审校。 */
export class SamplingAuditor {
  private counter = 0;
  private pick = Math.floor(Math.random() * 20);
  private readonly enabled: boolean;
  constructor(every = 20, enabled = true) { this.every = every; this.enabled = enabled; this.pick = Math.floor(Math.random() * this.every); }
  private readonly every: number;
  /** 返回 true 表示本段虽符合快速路径，仍需完整审校；抽样关闭时恒 false */
  shouldAudit(): boolean {
    if (!this.enabled) return false;
    const hit = this.counter === this.pick;
    this.counter++;
    if (this.counter >= this.every) { this.counter = 0; this.pick = Math.floor(Math.random() * this.every); }
    return hit;
  }
}
