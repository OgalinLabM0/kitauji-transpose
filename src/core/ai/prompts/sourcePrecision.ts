export const NUMERIC_CONTEXT_RULE = '数量须结合语境核对：不能颠倒上下限或改变数量。以下／以上通常包含端点，未満不包含；文学叙述中端点措辞不同而未影响实际含义，不单凭“以下→不到”判错。年龄资格、人数门槛、精确条件或情节依赖端点时必须保留，报告时指出具体影响；不强求参考译文的字面形式。';

/** Short, source-triggered review guidance. Never a word ban or automatic verdict. */
export function sourcePrecisionRules(source: string): string[] {
  const rules: string[] = [];
  if (/以下|以上|未満/u.test(source)) rules.push(NUMERIC_CONTEXT_RULE);
  if (/(?:隣|となり|そば|傍)/u.test(source)) {
    rules.push('方位专项：隣／となり／そば表示相邻或在旁。中文“隔壁”通常额外指定房间或住处相邻；请在原文和提供的原文语境里寻找这个依据。只有人物在旁而没有房间、住处等依据时，应指出范围被缩窄；若语境已明确邻居或相邻房间，则可以保留“隔壁”。不能因为中文顺口就推定居住关系。');
  }
  if (/は\s*(?:[—―ー]{2,}|…{2,})(?:[」』\s]|$)/u.test(source)) {
    rules.push('未完句专项：话题助词は后直接中断，没有述语时，は本身不提供判断词“是”。中文若在这个中断处增加“是”、动作或意愿，就替作者选择了尚未说出的述语，应报告这项增译并引用新增片段。保留话题和未说完的状态；即使上下文已知人物身份，也不能替这句被打断的话补完。只有当前句已经说出的内容可以译出，不因中文顺口而补足。');
  }
  return rules;
}
