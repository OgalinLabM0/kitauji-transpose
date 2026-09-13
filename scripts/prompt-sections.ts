/** Parse the complete rule source before allowing the generated artifact to be replaced. */
export function parseRuleSections(doc: string): Record<string, string> {
  const expected = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const sections: Record<string, string> = {};
  let key: string | undefined;
  let body: string[] = [];
  const flush = () => {
    if (!key) return;
    if (!body.slice(1).some(line => line.trim())) throw new Error(`规则章节 ${key} 没有正文`);
    sections[key] = body.join('\n')
      .replace(/（[^（）]*[A-Z_]+\.md[^（）]*）/g, '')
      .replace(/[A-Z_]+\.md(?: 第[^。；，\n]*节)?/g, '项目设计').trim();
  };
  for (const line of doc.replace(/\r\n?/g, '\n').split('\n')) {
    const match = /^## ([一二三四五六七八九十]+)、(.*)$/.exec(line);
    if (match) {
      flush();
      key = match[1]!;
      if (key in sections) throw new Error(`规则章节重复：${key}`);
      body = [line];
    } else if (key) body.push(line);
  }
  flush();
  if (Object.keys(sections).join(',') !== expected.join(',')) throw new Error('规则章节缺失或顺序错误，必须完整包含一至九章');
  return sections;
}
