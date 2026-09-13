/** Stable shared requirements, included in actual writing/review contracts and their hashes. */
export const MANDATORY_REQUIREMENTS = `【原作保真必守规则 v1】
世界观、职阶和称号保留原词区分，不因中文常见叫法而合并，師／士不能互换。没有用户另行确认译名时，魔導師→魔导师、魔法使い→魔法使、魔術師→魔术师、錬金術師→炼金术师；这些例子说明区分原词，不是脱离语境替换。纯汉字词不进入术语确认，不代表可随意换词。
原文数字保留原写法，不将汉字数字与阿拉伯数字互换。数量含义与数字写法分别核对，文学端点措辞的许可不授权改写数字形式。
あいつ／こいつ／そいつ／奴等中性指代不授权补他或她；已知人物性别也不构成正文补性别的依据。原文明示的自称和主语不得为了简练删除；省略只限原文本来省略或已明确获准的情况。
人物用名字自称时先看说话人，不擅改成“名字＋你”。原文只有先生／お婆さん等称谓时，不添加“我的／你的”等所属关系。
颜文字是完整视觉片段，字符与顺序原样保留，不翻成动作说明，也不替换成另一张脸。上述要求同样适用于初译、局部修正、自动修复与最终核对。`;

const stages=new Set(['faithful-translator','chinese-editor','sentence-translator','fidelity-reviewer','address-reviewer','trajectory-reviewer','dispute-reviewer','repair-resolution-reviewer','chapter-reading-reviewer']);
export function withMandatoryRequirements(prompt:string,workstation:string):string {
 return stages.has(workstation)&&!prompt.includes(MANDATORY_REQUIREMENTS)?`${prompt}\n\n${MANDATORY_REQUIREMENTS}`:prompt;
}
