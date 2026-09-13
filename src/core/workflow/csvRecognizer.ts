/** CSV格式智能识别：用AI分析CSV结构，映射到标准字段 */
import type { ProviderConfig } from '@core/ai';
import { chat } from '@core/ai/providers/adapter';

export interface CsvColumn {
  index: number;
  name: string;
  sampleValues: string[];
}

export interface CsvMapping {
  termJp?: number;  // 日文术语列索引
  termZh?: number;  // 中文译名列索引
  termType?: number;  // 类型列索引
  lockLevel?: number;  // 锁定级别列索引
  notes?: number;  // 备注列索引
  confidence: number;  // 识别置信度 0-1
  reason: string;  // 识别理由
}

const RECOGNITION_PROMPT = `你是CSV格式分析专家。用户导入了一个术语表CSV文件，请分析其列结构并映射到标准字段。

标准字段定义：
- termJp: 日文原文术语（必需）
- termZh: 中文译名
- termType: 术语类型（person/place/organization/work/concept等）
- lockLevel: 锁定级别（suggested/confirmed/hard-locked）
- notes: 备注说明

分析规则：
1. 日文列特征：包含平假名、片假名、汉字，没有简体中文字符
2. 中文列特征：主要是简体中文字符
3. 类型列特征：值是英文类型词（person/place）或中文（人物/地点）
4. 锁定列特征：值是锁定相关词（locked/suggested/硬锁定/建议）
5. 备注列特征：列名包含"备注"/"notes"/"说明"，或内容较长

请返回JSON格式的映射结果，包含：
- termJp: 日文列的索引（0开始）
- termZh: 中文列的索引（可选）
- termType: 类型列的索引（可选）
- lockLevel: 锁定级别列的索引（可选）
- notes: 备注列的索引（可选）
- confidence: 整体置信度 0-1
- reason: 识别理由

只返回JSON，不要其他文字。`;

/**
 * 分析CSV内容，识别列结构
 */
export async function recognizeCsvStructure(
  csvText: string,
  config: ProviderConfig
): Promise<CsvMapping> {
  const lines = csvText.split(/\r?\n/).filter(l => l.trim());
  if (lines.length === 0) {
    throw new Error('CSV文件为空');
  }

  // 解析前几行作为样本
  const sampleLines = lines.slice(0, Math.min(10, lines.length));
  const rows = sampleLines.map(line => {
    // 简单CSV解析（支持逗号和制表符）
    return line.split(/[,\t，]/).map(c => c.trim().replace(/^"|"$/g, ''));
  });

  const header = rows[0];
  if (!header || header.length === 0) {
    throw new Error('CSV格式无效');
  }

  // 构建列信息
  const columns: CsvColumn[] = [];
  const colCount = Math.max(...rows.map(r => r.length));

  for (let i = 0; i < colCount; i++) {
    const sampleValues = rows.slice(1).map(r => r[i] || '').filter(v => v);
    columns.push({
      index: i,
      name: header[i] || `列${i + 1}`,
      sampleValues: sampleValues.slice(0, 5),
    });
  }

  // 用AI分析列结构
  const userMessage = `CSV列信息：\n${JSON.stringify(columns, null, 2)}\n\n请分析并返回字段映射。`;

  try {
    const response = await chat(config, { system: RECOGNITION_PROMPT, user: userMessage, jsonMode: true });

    const text = response.text.trim();
    // 提取JSON（可能被```json包裹）
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('AI返回格式错误');
    }

    const mapping = JSON.parse(jsonMatch[0]) as CsvMapping;

    // 验证必需字段
    if (mapping.termJp === undefined) {
      throw new Error('无法识别日文术语列');
    }

    return mapping;
  } catch (e) {
    // AI识别失败，回退到启发式规则
    return heuristicMapping(columns);
  }
}

/**
 * 启发式规则识别（AI失败时的备用方案）
 */
function heuristicMapping(columns: CsvColumn[]): CsvMapping {
  const mapping: CsvMapping = { confidence: 0.5, reason: '使用启发式规则识别' };

  for (const col of columns) {
    const name = col.name.toLowerCase();
    const samples = col.sampleValues.join(' ');

    // 日文列：包含平假名/片假名
    if (!mapping.termJp && (/[぀-ゟ゠-ヿ]/.test(samples) || /原文|日文|term_jp|japanese/i.test(name))) {
      mapping.termJp = col.index;
      continue;
    }

    // 中文列：包含简体中文
    if (!mapping.termZh && (/[一-龥]/.test(samples) && !/[぀-ゟ゠-ヿ]/.test(samples)) || /译文|中文|translation|chinese/i.test(name)) {
      mapping.termZh = col.index;
      continue;
    }

    // 类型列
    if (!mapping.termType && (/type|类型/i.test(name) || /^(person|place|organization|work|concept|人物|地点|组织|作品|概念)$/i.test(samples))) {
      mapping.termType = col.index;
      continue;
    }

    // 锁定列
    if (!mapping.lockLevel && (/lock|锁定/i.test(name) || /locked|suggested|confirmed|硬锁定|建议/i.test(samples))) {
      mapping.lockLevel = col.index;
      continue;
    }

    // 备注列
    if (!mapping.notes && /note|备注|说明|remark/i.test(name)) {
      mapping.notes = col.index;
    }
  }

  if (mapping.termJp === undefined) {
    // 最后的回退：第一列是日文
    mapping.termJp = 0;
    mapping.confidence = 0.3;
    mapping.reason = '无法识别，假设第一列为日文';
  }

  return mapping;
}

/**
 * 生成标准CSV模板
 */
export function generateCsvTemplate(): string {
  const header = '原文,译文,类型,锁定,备注';
  const examples = [
    'リスナー,听众,concept,confirmed,直播用语',
    'ドリームライト,Dreamlight,organization,hard-locked,组织名',
    '東京タワー,东京塔,place,confirmed,',
    '佐藤さん,小佐藤,person,suggested,需确认称呼风格',
  ];
  return [header, ...examples].join('\n');
}
