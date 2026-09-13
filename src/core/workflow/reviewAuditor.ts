/**
 * 复核队列AI辅助审核：对复核项生成推荐（接受/拒绝/不确定）
 */
import { chat, type ProviderConfig } from '@core/ai';
import type { ReviewItemView, ReviewKind } from '@shared/types';

const REVIEW_PROMPTS: Record<ReviewKind, string> = {
  'term-proposal': `你是术语译名审核专家。用户需要确认AI提案的专有名词译名。

审核要点：
1. 译名准确性：音译是否规范（人名/地名），意译是否恰当（概念/组织）
2. 风格一致性：与已有术语保持统一风格
3. 语境适配性：符合作品背景和角色设定
4. 无明显错误

推荐accept：译名准确合理，可直接采纳
推荐reject：译名有明显问题（错误、不当、风格不符）
标记uncertain：需要更多信息或人工判断

输出JSON：{"action":"accept"|"reject"|"uncertain","confidence":0-1,"reason":"一句话说明判断依据"}`,

  'ambiguity': `你是多义词辨析专家。判断日语外来词在具体语境下的正确含义。

审核要点：
1. 上下文分析：根据前后文确定词义
2. 语境匹配度：该义项是否符合当前场景
3. 其他义项排除：其他候选义项为何不适用

推荐accept：AI推断的义项明确正确
推荐reject：AI推断错误，应选其他义项
标记uncertain：上下文不足以确定，或多个义项都可能

输出JSON：{"action":"accept"|"reject"|"uncertain","confidence":0-1,"reason":"基于什么语境线索得出此结论"}`,

  'honorific-first': `你是人物称呼审核专家。判断角色间称呼是否合适。

审核要点：
1. 关系匹配：称呼反映人物间的亲密度、尊卑、熟悉度
2. 场景适配：该场景下使用此称呼是否自然
3. 风格统一：与其他人物称呼保持一致风格（借用式/本土式）
4. 固定性判断：该称呼是否应全书统一

推荐accept：称呼选择合理，符合人物关系
推荐reject：称呼不当（过于亲密/生疏/不符合角色性格）
标记uncertain：需要了解更多人物背景或关系发展

输出JSON：{"action":"accept"|"reject"|"uncertain","confidence":0-1,"reason":"基于什么人物关系或场景判断"}`,

  'review-block': `你是翻译质量审校专家。审核AI发现的翻译问题及修复建议。

审核要点：
1. 问题诊断准确性：AI指出的问题是否确实存在
2. 修复方案可行性：建议的修改是否解决问题且不引入新问题
3. 原意保真度：修改后是否仍符合日文原意
4. 中文表达自然度：修改后的中文是否流畅自然

推荐accept：问题诊断正确且修复方案合理
推荐reject：问题诊断错误或修复方案不当
标记uncertain：需要人工判断或对比多个修改方案

输出JSON：{"action":"accept"|"reject"|"uncertain","confidence":0-1,"reason":"问题是否存在，修复是否合理","suggestedFix":"（可选）更好的修复方案"}`,

  'quirk-candidate': `你是角色语癖识别专家。判断某个反复出现的表达是否为角色语癖。

审核要点：
1. 特征性：该表达是否具有角色独特性（非通用口语）
2. 频率：出现次数是否足够（建议≥3次）
3. 规律性：是否在特定句尾/场景反复出现
4. 翻译模式：提议的翻译模式是否合理可行

推荐accept：确认为语癖，翻译模式合理
推荐reject：非语癖（通用口语、偶然表达、频率不足）
标记uncertain：需要更多对话样本或角色背景信息

输出JSON：{"action":"accept"|"reject"|"uncertain","confidence":0-1,"reason":"基于频率、特征性、规律性的判断"}`,

  // 其他类型默认uncertain
  'failed': 'uncertain',
  'lock-conflict': 'uncertain',
  'gender-plural': 'uncertain',
  'wordplay': 'uncertain',
  'glossary-deviation': 'uncertain',
  'stale-knowledge': 'uncertain',
  'warning': 'uncertain',
};

export interface ReviewRecommendation {
  action: 'accept' | 'reject' | 'uncertain';
  confidence: number;
  reason: string;
  suggestedFix?: string;
}

/**
 * 对单个复核项生成AI推荐
 */
export async function reviewItem(
  item: ReviewItemView,
  config: ProviderConfig,
  signal?: AbortSignal
): Promise<ReviewRecommendation> {
  const prompt = REVIEW_PROMPTS[item.kind];

  // 不支持AI审核的类型，返回uncertain
  if (!prompt || prompt === 'uncertain') {
    return {
      action: 'uncertain',
      confidence: 0,
      reason: '此类型需人工审核'
    };
  }

  try {
    const {knowledgeDecision: _journal, knowledgeDecisionHistory: _history, ...reviewPayload} = item.payload;
    const userPrompt = `【复核项】
标题：${item.title}
类型：${item.kind}
详细信息：${JSON.stringify(reviewPayload, null, 2)}

请审核并给出推荐。`;

    const response = await chat(config, {
      system: prompt,
      user: userPrompt,
      jsonMode: true,
      maxOutputTokens: 1024,
      ...(signal ? { signal } : {})
    });

    const result = JSON.parse(response.text) as ReviewRecommendation;

    // 验证返回格式
    if (!result.action || !['accept', 'reject', 'uncertain'].includes(result.action)) {
      return { action: 'uncertain', confidence: 0, reason: 'AI返回格式错误' };
    }

    return {
      action: result.action,
      confidence: Math.min(Math.max(result.confidence ?? 0.5, 0), 1),
      reason: result.reason || '无理由',
      ...(result.suggestedFix ? { suggestedFix: result.suggestedFix } : {})
    };
  } catch (e) {
    signal?.throwIfAborted();
    return {
      action: 'uncertain',
      confidence: 0,
      reason: `AI审核失败：${(e as Error).message}`
    };
  }
}

/**
 * 批量审核复核项
 */
export async function reviewBatch(
  items: ReviewItemView[],
  config: ProviderConfig,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal
): Promise<Map<string, ReviewRecommendation>> {
  const results = new Map<string, ReviewRecommendation>();

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    signal?.throwIfAborted();
    const recommendation = await reviewItem(item, config, signal);
    signal?.throwIfAborted();
    results.set(item.id, recommendation);
    onProgress?.(i + 1, items.length);
  }

  return results;
}
