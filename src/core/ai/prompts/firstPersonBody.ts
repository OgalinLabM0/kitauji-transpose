/** Default confirmed convention; this is about Chinese wording, separate from ruby placement. */
export const FIRST_PERSON_BODY = '普通一人称俺／僕／私的中文正文默认用“我”，日文形式差异由程序以ruby保留。不能仅凭俺就使用中文方言“俺”或擅加“老子”“本大爷”的强度；确有额外原文证据才可例外。わし→老夫、拙者→在下等明确特殊自称和合法主语省略仍可保留。核对的不是字形相同，而是有没有无依据增加地域、身份或粗鲁色彩。';
export function firstPersonBodyRule(source:string):string | null {
  return /(?:俺|おれ|僕|ぼく|私|わたし)(?:は|が|の|を|に|と|も|で|だ|[、。！？!?”」』])/u.test(source) ? FIRST_PERSON_BODY : null;
}
