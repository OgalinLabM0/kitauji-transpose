/**
 * 把 docs/标准/TRANSLATION_RULES.md 按「## 一、…」章节切片，生成 src/core/ai/prompts/rules.generated.ts。
 * 文档是提示词唯一真源；改文档后运行 `npm run gen:prompts`。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRuleSections } from './prompt-sections';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const doc = readFileSync(join(root, 'docs/标准/TRANSLATION_RULES.md'), 'utf8');
const hash = createHash('sha256').update(doc).digest('hex');

const sections = parseRuleSections(doc);

const out = `/* 自动生成：源为 docs/标准/TRANSLATION_RULES.md，请勿手改。重新生成：npm run gen:prompts */
export const RULES_DOC_HASH = ${JSON.stringify(hash)};
export const RULE_SECTIONS: Readonly<Record<string, string>> = ${JSON.stringify(sections, null, 2)};
`;
mkdirSync(join(root, 'src/core/ai/prompts'), { recursive: true });
writeFileSync(join(root, 'src/core/ai/prompts/rules.generated.ts'), out);
console.log('sections:', Object.keys(sections).join(','), '| hash', hash.slice(0, 8));
