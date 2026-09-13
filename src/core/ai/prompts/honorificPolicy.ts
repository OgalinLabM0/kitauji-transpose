/** Selected series policy only; never infer relationship or gender from a suffix. */
export function honorificPolicy(style: 'loan' | 'native'): string {
  return style === 'loan'
    ? '称呼模式：保留日式称呼。姓名后缀さん→桑、くん／君→君、ちゃん→酱；不得自行换成先生、小姐、同学、小X或删去。仅对人名后的敬称适用，不把代词君、皆さん等普通词机械替换。人物关系变化不等于可以擅自切换模式；本处用户明确确认的称谓优先，冲突须报告。'
    : '称呼模式：按语境译成中文。さん本身不确定性别或职业；くん／君本身不证明是学生，ちゃん本身不证明是儿童。只有校园同辈关系有原文依据才考虑同学，正式成人称呼结合已知身份考虑先生／女士，亲昵称呼有依据才考虑小X；不凭后缀猜小姐、老师或博士。姓名、说话人→受话人、关系阶段和场景共同决定；没有足够依据时报告honorific-first，不编造身份。已确认本处称呼优先，同场景不任意改称。';
}
