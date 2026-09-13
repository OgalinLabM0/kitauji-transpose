import {visibleNameSource} from '../../validation/nameEvidence';

/** A local speech-act structure hint, not a claim that the quoted act happened. */
export function speechActHintsFor(source:string):string[]{
  return /(?:いただき|頂き|くださり|下さり)[ \t\u3000]*[、，,][ \t\u3000]*(?:ありがとう|有り難う|有難う)/u.test(visibleNameSource(source))
    ? ['命中的受惠连用（いただき／頂き／くださり／下さり）与后续致谢须区分：前部分是受惠事由，ありがとう是致谢。保留读点两侧为非空分句，不压成单一“感谢X”，也不重复两次致谢。依当前原文选择自然措辞，不照搬固定用词或增加敬语强度；保留否定、假设和引用外框，不把引用中的致谢或整段内容断定为已经发生。这里只提示局部句法，不补人物、事实或解释。']
    : [];
}

/** Source-triggered grammar examples: guidance, never a replacement or acceptance rule. */
export function syntaxHintsFor(source:string, options?:{cognitiveOnly?:boolean}):string[] {
  const hints:string[]=[];
  if(!options?.cognitiveOnly && /願わくは[、，,]/u.test(visibleNameSource(source)))hints.push('願わくは后有读点时，先辨认这是引出愿望的插入语。可按语境用“可以的话”等能独立停顿的表达，再接愿望内容；原作停顿可以保留，不能仅因“希望／但愿”后有逗号就判病句；结合完整语境核对是否仍能理解愿望内容。不能增加现实条件、增强愿望或补出原文没有的人物；具体措辞依原文语气决定。');
  if(!options?.cognitiveOnly && /(?:だった|であった|である|です|ます|た|る|い)(?:が|けれど|けど)[─—…]+[、，,]$/u.test(visibleNameSource(source).trim()))hints.push('句末转折尚未说完：先核对が／けれど／けど是否连接前面的谓语。中文可把让步关系移到同一分句的开头，用“虽然／尽管……”承接原文内容，并保留结尾中断；不必把“然而”硬接在名词后，再擅加逗号救句法。不得补出后半句的结果、人物或原因。这里只提供句法选择，不要求固定措辞。');
  if(!options?.cognitiveOnly && /ずに/u.test(source))hints.push('「AせずにB」中A没有发生，B发生了。中文要连接成一句，不能把“没做A”和B直接挤在一起；可用自然的否定状语或“没……便／就……”句式，仍按上下文判断语气。例：彼は返事をせずに席を立った。→他没作答便站起身来。例句仅说明句法，不移入人物、动作或措辞。');
  if(/(?:だ|だった|である)と(?:思|おも)わ(?:せ|され)/u.test(source)) {
    const objectCausative = /を[、，,\s]*[^。！？\r\n、，,「」『』をに]{1,60}(?:だ|だった|である)と(?:思|おも)わせ/u.test(source);
    const passive = /(?:だ|だった|である)と(?:思|おも)わされ/u.test(source);
    hints.push(objectCausative
      ? '认知使役：程序只匹配到字面形式，尚未确定角色。“を”可能属于身份描述B内部的动作，不能只凭助词或A在B描述之外就判定角色。结合完整句法与前文，已确认A是被判断对象时，才考虑“A被认作／被当成B”；若A是被促使作判断的人，则表达A产生该判断，不能改成A被当成B。角色不明时不得强行定向。“思わされる”另按使役被动分析。否定、意愿与推测照原文，未明示的人物仍省略。这里只建议句法，A、B不进入正文。'
      : passive
        ? '认知使役被动“Bだと思わされた”中，被促使产生判断的人仍是判断者，B是判断内容；不能改成判断者被当成B。与主动使役“思わせた”区分，否定与推测照原文，未明示的人物仍省略。'
        : '认知使役须核对助词：“AにBだと思わせる”中的A是被促使作判断的人，B是判断内容，不能改成A被当成B。对象结构与判断者结构不能互换；否定、意愿与推测照原文，未明示的人物仍省略。');
  }
  if(!options?.cognitiveOnly && /と(?:[、，,][^。！？\r\n]{0,80})?(?:思(?:う|い|っ)|考え)/u.test(source))hints.push('「Xと考えた／思った」的X是想法内容，不是叙述者断定的现实，也不是与思考并行的动作。若另有说明所想之事的短语，须在中文里与X连接为同一次思考；不要另起一个没有对象的“想着”，也不要加“一边”制造同时动作。引用的想法不擅自改为“我”的自述。');
  return hints;
}
