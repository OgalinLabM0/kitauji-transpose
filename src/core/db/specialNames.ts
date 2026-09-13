/**
 * 统一专名锚定（special name anchoring）：
 * 日文原名是唯一主键。任何工位/UI 出现的人名、组织名、地名、能力名等专名，
 * 都先以日文原名在知识库（characters + aliases + glossary terms）里解析，
 * 得到权威中文译名；查不到则标记未建档。这保证同一专名全书只有一个中文译名，
 * 杜绝 AI 自由发挥导致"对不上号"。中文译名只由知识库决定，AI 永不发明。
 */
import type { ProjectStore } from './index';

export type EntityKind = 'character' | 'organization' | 'place' | 'ability' | 'item' | 'concept' | 'honorific' | 'other';

export interface ResolvedName {
  /** 日文原名（权威锚） */
  jp: string;
  /** 中文译名；未建档/未定时为 null */
  zh: string | null;
  /** 知识库实体 ID（character.id 或 term.id） */
  id: string | null;
  /** 实体类别 */
  kind: EntityKind;
  /** 是否成功锚定到知识库实体 */
  found: boolean;
}

const TERM_KIND_MAP: Record<string, EntityKind> = {
  person: 'character', place: 'place', organization: 'organization', ability: 'ability',
  item: 'item', concept: 'concept', honorific: 'honorific', other: 'other',
};

/** 解析单个日文专名 → 权威中文译名。优先 characters（含别名），其次 glossary terms。 */
/** 常见称谓后缀 → 中文默认对应（借用式 / 本土式）。作为称谓候选的确定性兜底，AI 候选夹假名时也能给出可用中文。 */
export const HONORIFIC_SUFFIX_ZH: Record<string, { loan: string; native: string }> = {
  'さん': { loan: '桑', native: '同学' }, 'ちゃん': { loan: '酱', native: '小{given}' }, 'くん': { loan: '君', native: '同学' }, '君': { loan: '君', native: '同学' },
  '様': { loan: '大人', native: '大人' }, 'さま': { loan: '大人', native: '大人' }, '先輩': { loan: '前辈', native: '学姐' }, 'せんぱい': { loan: '前辈', native: '学姐' },
  '先生': { loan: '老师', native: '老师' }, 'せんせい': { loan: '老师', native: '老师' }, '殿': { loan: '殿', native: '大人' }, 'どの': { loan: '殿', native: '大人' }, '氏': { loan: '氏', native: '先生' }, 'たん': { loan: '碳', native: '小{given}' },
  'お姉ちゃん': { loan: '姐姐', native: '姐姐' }, 'お兄ちゃん': { loan: '哥哥', native: '哥哥' }, '姉さん': { loan: '姐姐', native: '姐姐' }, '兄さん': { loan: '哥哥', native: '哥哥' },
  '中尉': { loan: '中尉', native: '中尉' }, '大尉': { loan: '大尉', native: '大尉' }, '少尉': { loan: '少尉', native: '少尉' }, '少佐': { loan: '少佐', native: '少佐' }, '中佐': { loan: '中佐', native: '中佐' }, '大佐': { loan: '大佐', native: '大佐' },
  '隊長': { loan: '队长', native: '队长' }, '部長': { loan: '部长', native: '部长' }, '会長': { loan: '会长', native: '会长' }, '社長': { loan: '社长', native: '社长' }, '博士': { loan: '博士', native: '博士' }, '教授': { loan: '教授', native: '教授' },
};
export const HONORIFIC_SUFFIX_RE = new RegExp(`(${Object.keys(HONORIFIC_SUFFIX_ZH).sort((a, b) => b.length - a.length).join('|')})$`);
export const hasKana = (s: string): boolean => /[ぁ-ゖァ-ヺー]/.test(s);

/**
 * 从全名的日/中对照推导某个名字部件（姓/名）的中文：
 *  - 带分隔符的外文名：「ターニャ・デグレチャフ」/「谭雅·提古雷查夫」按部件对齐 → 「デグレチャフ」=「提古雷查夫」
 *  - 等长汉字名：「加藤葉月」/「加藤叶月」按位置切片 → 「葉月」=「叶月」、「高坂」=「高坂」
 *  推不出来返回 null（调用方回退）。
 */
export function derivePartZh(fullJp: string, fullZh: string, partJp: string): string | null {
  if (!fullJp || !fullZh || !partJp || partJp === fullJp) return partJp === fullJp ? fullZh : null;
  const jpParts = fullJp.split(/[・･=＝\s　]+/).filter(Boolean), zhParts = fullZh.split(/[・･·\s]+/).filter(Boolean);
  if (jpParts.length > 1 && jpParts.length === zhParts.length) {
    const i = jpParts.indexOf(partJp); if (i >= 0) return zhParts[i]!;
    // 部件本身可能是连续多个部件（「ヴィクトーリヤ・イヴァーノヴナ」）
    for (let a = 0; a < jpParts.length; a++) for (let b = a + 1; b <= jpParts.length; b++) if (jpParts.slice(a, b).join('・') === partJp.replace(/[･=＝\s　]/g, '・')) return zhParts.slice(a, b).join('·');
  }
  if (fullJp.length === fullZh.length) { const i = fullJp.indexOf(partJp); if (i >= 0) return fullZh.slice(i, i + partJp.length); }
  return null;
}

/**
 * 某个名字形（全名/姓/名/别名）的"当前最佳中文名"。优先级：
 *  该形式的已确认术语 > 该形式对应的人物规范名（当形式就是规范名）> 该形式的待确认提案（tentative）
 *  > 由人物全名的中文按部件推导（derivePartZh）> 人物全名中文（最后兜底，tentative）。
 * 关键：「久美子」必须得到「久美子」而不是「黄前久美子」，否则称呼会变成"黄前久美子酱"。
 */
export function bestZhName(store: ProjectStore, seriesId: string, jpName: string): { zh: string | null; tentative: boolean } {
  const name = (jpName ?? '').trim(); if (!name) return { zh: null, tentative: false };
  const proposalFor = (jp: string): string | null => {
    for (const it of store.translations.listPendingByKind(seriesId, 'term-proposal')) {
      const pl = it.payload as { termJp?: string; preSelected?: string; candidates?: { zh: string }[] };
      if (pl.termJp === jp) return pl.preSelected ?? pl.candidates?.[0]?.zh ?? null;
    }
    return null;
  };
  // 1) 该形式的已确认术语
  const exact = store.glossary.findTermByJp(seriesId, name); if (exact?.term_zh) return { zh: exact.term_zh, tentative: false };
  // 2) 人物：形式就是规范名
  const char = store.knowledge.findByName(seriesId, name) ?? (() => { const rv = store.knowledge.resolveNameVariant(seriesId, name); return rv.id ? store.knowledge.getCharacter(rv.id) : undefined; })();
  // 汉字名没有分隔符，姓/名无法按部件规则解析：唯一一个以该形式开头或结尾（≥2 字）的人物即视为其姓/名
  const charKanji = char ?? (() => { if (name.length < 2 || /[ァ-ヺー]/.test(name)) return undefined; const hits = store.knowledge.charactersAt(seriesId, Number.MAX_SAFE_INTEGER).filter(c => c.canonical_name_jp !== name && c.canonical_name_jp.length > name.length && (c.canonical_name_jp.startsWith(name) || c.canonical_name_jp.endsWith(name))); return hits.length === 1 ? hits[0] : undefined; })();
  if (char && char.canonical_name_jp === name && char.canonical_name_zh) return { zh: char.canonical_name_zh, tentative: false };
  // 3) 该形式的待确认提案
  const prop = proposalFor(name); if (prop) return { zh: prop, tentative: true };
  const owner = char ?? charKanji;
  if (!owner) return { zh: null, tentative: false };
  // 4) 从全名中文推导部件
  const fullZh = owner.canonical_name_zh ?? store.glossary.findTermByJp(seriesId, owner.canonical_name_jp)?.term_zh ?? null;
  const fullTentative = !fullZh; const fullZhAny = fullZh ?? proposalFor(owner.canonical_name_jp);
  if (!fullZhAny) return { zh: null, tentative: false };
  const derived = derivePartZh(owner.canonical_name_jp, fullZhAny, name);
  if (derived) return { zh: derived, tentative: fullTentative };
  // 5) 兜底：全名中文（标记 tentative，调用方知道这不是部件）
  return { zh: fullZhAny, tentative: true };
}

/** 把一个日文称呼形（名字+后缀 / 裸名）确定性地渲染成中文候选：名字用最佳中文名，后缀查表。名字无中文时返回 null。 */
export function renderAddressForm(store: ProjectStore, seriesId: string, form: string, style: 'loan' | 'native'): { zh: string; basis: string } | null {
  const m = HONORIFIC_SUFFIX_RE.exec(form);
  const suffix = m?.[1] ?? '';
  const base = suffix ? form.slice(0, -suffix.length) : form;
  if (!base) return null;
  const name = bestZhName(store, seriesId, base);
  if (!name.zh) return null;
  if (!suffix) return { zh: name.zh, basis: name.tentative ? '裸名（译名待确认）' : '裸名' };
  // Native address requires relationship evidence; suffix alone cannot imply student, gender or intimacy.
  if (style === 'native') return null;
  const map = HONORIFIC_SUFFIX_ZH[suffix]!; const tpl = map.loan;
  // 「小{given}」：取中文名最后两字作"名"，避免「小黄前久美子」
  const given = name.zh.length > 2 ? name.zh.slice(-2) : name.zh;
  const zh = tpl.includes('{given}') ? tpl.replace('{given}', given) : name.zh + tpl;
  return { zh, basis: `借用式后缀${name.tentative ? '（译名待确认）' : ''}` };
}

export function resolveEntityName(store: ProjectStore, seriesId: string, jpName: string, at = Number.MAX_SAFE_INTEGER): ResolvedName {
  const name = (jpName ?? '').trim();
  if (!name) return { jp: name, zh: null, id: null, kind: 'other', found: false };

  // 1) characters：规范日文名精确匹配
  const char = store.knowledge.findByName(seriesId, name, at);
  if (char) {
    return { jp: name, zh: char.canonical_name_zh ?? null, id: char.id, kind: 'character', found: true };
  }
  // 2) glossary terms：term_jp 匹配
  const term = store.glossary.findTermByJp(seriesId, name);
  if (term) {
    return { jp: name, zh: term.term_zh ?? null, id: term.id, kind: TERM_KIND_MAP[term.term_type] ?? 'other', found: true };
  }
  // 3) 遍历 characters，日文名包含匹配（处理带后缀/变体，如「ターニャ中尉」）
  const chars = store.knowledge.charactersAt(seriesId, at);
  const loose = chars.find(c => name.includes(c.canonical_name_jp) || c.canonical_name_jp.includes(name));
  if (loose) {
    return { jp: name, zh: loose.canonical_name_zh ?? null, id: loose.id, kind: 'character', found: true };
  }
  // 查不到
  return { jp: name, zh: null, id: null, kind: 'other', found: false };
}

/**
 * 双向锚定：先按日文名查，若 AI 已输出中文译名（漏网/旧数据），按中文译名反查
 * characters.canonical_name_zh 与 glossary term_zh，把它锚定回标准角色，并补全日文原名。
 * 这保证即使名字以中文形式出现，UI 也能显示「中文（日文）」并绑定同一实体。
 */
export function resolveEntityNameBidirectional(store: ProjectStore, seriesId: string, nameStr: string, at = Number.MAX_SAFE_INTEGER): ResolvedName {
  const name = (nameStr ?? '').trim();
  if (!name) return { jp: name, zh: null, id: null, kind: 'other', found: false };

  // 优先日文锚
  const byJp = resolveEntityName(store, seriesId, name, at);
  if (byJp.found) return byJp;

  // 中文反查：characters.canonical_name_zh 或 alias
  const chars = store.knowledge.charactersAt(seriesId, at);
  const asZh = chars.find(c => (c.canonical_name_zh ?? '').trim() === name);
  if (asZh) {
    return { jp: asZh.canonical_name_jp, zh: asZh.canonical_name_zh, id: asZh.id, kind: 'character', found: true };
  }
  // glossary term_zh 反查
  const terms = store.glossary.activeTerms(seriesId);
  const termAsZh = terms.find(t => (t.term_zh ?? '').trim() === name);
  if (termAsZh) {
    return { jp: termAsZh.term_jp, zh: termAsZh.term_zh, id: termAsZh.id, kind: TERM_KIND_MAP[termAsZh.term_type] ?? 'other', found: true };
  }
  // 中文名包含匹配（处理「谭雅中尉」这种带后缀）
  const looseZh = chars.find(c => (c.canonical_name_zh ?? '').trim() && name.includes(c.canonical_name_zh!));
  if (looseZh) {
    return { jp: looseZh.canonical_name_jp, zh: looseZh.canonical_name_zh, id: looseZh.id, kind: 'character', found: true };
  }
  return { jp: name, zh: name, id: null, kind: 'other', found: false };
}

/** 批量解析一组日文专名；返回按输入顺序对应的结果，并去重合并同一实体的不同写法。 */
export function resolveAllNames(store: ProjectStore, seriesId: string, jpNames: string[]): Map<string, ResolvedName> {
  const out = new Map<string, ResolvedName>();
  // 缓存：日文名规范化后 → 实体 id / 中文译名，供别名合并
  for (const n of jpNames) {
    if (out.has(n)) continue;
    const r = resolveEntityName(store, seriesId, n);
    out.set(n, r);
  }
  return out;
}

/** 把一个日文名渲染成「中文（日文）」显示串；未建档则只显示原文并标灰标记。 */
export function displayName(r: ResolvedName | null | undefined): string {
  if (!r) return '';
  if (r.zh) return `${r.zh}（${r.jp}）`;
  return `${r.jp}`;
}

/** 若一个日文名在知识库里已有权威译名但用户另给了中文串，返回权威译名（用于一致性校验）。 */
export function canonicalZhOf(store: ProjectStore, seriesId: string, jpName: string): string | null {
  return resolveEntityName(store, seriesId, jpName).zh;
}
