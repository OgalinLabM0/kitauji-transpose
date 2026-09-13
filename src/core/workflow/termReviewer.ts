/**
 * 术语提取二次审核：用思考模型审核AI提取的术语，过滤不必要的词、拆分复合词
 */
import type { ProjectStore } from '@core/db';
import { chat, type ProviderConfig } from '@core/ai';

export interface TermCandidate {
  termJp: string;
  termType: string;
  confidence: number;
  occurrenceCount: number;
}

export interface TermReviewResult {
  action: 'keep' | 'remove' | 'split';
  reason: string;
  /** 如果action是split，这里是拆分后的术语 */
  splitInto?: string[];
}

const REVIEW_PROMPT = `你是术语表质量审核专家。审核从日文轻小说中提取的术语，判断是否应该保留、删除或拆分。

# 删除规则

1. **通用词汇**：不是专有名词的普通词
   - 通用称呼：さん、ちゃん、くん、様、殿、先生（单独出现）
   - 通用职业：社長、部長、課長、先生、教授（无具体人名）
   - 通用物品：携帯電話、パソコン、車

2. **中文样式的日文**：汉字占比>80%且看起来像中文的词
   - 地址：東京都文京区音羽二‐一二‐二一
   - 公司全称：株式会社講談社、有限会社XX
   - 纯数字编号：第224中隊、編號XXX

3. **描述性短语**：完整句子或长短语，不是名词性术语
   - 英検一級はクソゲー
   - XXについて話す

4. **游戏/网络通用术语**：
   - ＲＴＡ（speedrun）
   - リスナーさん（观众）
   - 配信者、実況者

# 拆分规则

复合词应该拆分成独立术语：

1. **组织名+类型后缀**：
   - ドリームライト・プロダクション → ドリームライト + プロダクション
   - 株式会社講談社 → 講談社
   - XXアカデミー → XX + アカデミー

2. **专有名词+通用后缀**：
   - 帝国軍 → 帝国 + 軍
   - ダンジョンシーカー・アカデミー → ダンジョンシーカー + アカデミー
   - 〜王国、〜帝国、〜共和国 → 拆分

3. **人名+称谓**：
   - 田中さん → 田中（称谓由称谓系统处理）
   - 佐藤先生 → 佐藤

# 保留规则

1. **真正的专有名词**：
   - 人名、地名、组织名、作品名
   - 魔法/技能的具体名称（非类型词）
   - 独特的物品/概念名称

2. **关键术语**：
   - 在文中频繁出现（≥5次）
   - 对剧情/设定重要的词

# 输出格式

JSON对象，包含：
- action: "keep" | "remove" | "split"
- reason: 简短理由（中文，一句话）
- splitInto: 如果是split，列出拆分后的术语数组

示例：
{"action":"remove","reason":"通用称呼，不是专有名词"}
{"action":"split","reason":"组织名+类型后缀应拆分","splitInto":["ドリームライト","プロダクション"]}
{"action":"keep","reason":"关键人物名"}`;

export async function reviewTermBatch(
  terms: TermCandidate[],
  config: ProviderConfig
): Promise<Map<string, TermReviewResult>> {
  const results = new Map<string, TermReviewResult>();

  // 分批审核，每批10个术语
  for (let i = 0; i < terms.length; i += 10) {
    const batch = terms.slice(i, i + 10);
    const userPrompt = `请审核以下术语：

${batch.map((t, idx) => `${idx + 1}. ${t.termJp}（类型：${t.termType}，出现${t.occurrenceCount}次，置信度${t.confidence.toFixed(2)}）`).join('\n')}

对每个术语输出一个JSON对象，用数组包裹。`;

    try {
      const response = await chat(config, {
        system: REVIEW_PROMPT,
        user: userPrompt,
        jsonMode: true,
        maxOutputTokens: 4096
      });

      const parsed = JSON.parse(response.text) as TermReviewResult[];
      if (Array.isArray(parsed) && parsed.length === batch.length) {
        batch.forEach((term, idx) => {
          results.set(term.termJp, parsed[idx]!);
        });
      }
    } catch (e) {
      // 失败时默认保留
      batch.forEach(term => {
        results.set(term.termJp, { action: 'keep', reason: 'AI审核失败，默认保留' });
      });
    }
  }

  return results;
}
