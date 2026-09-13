/** Keep the original diagnostic available while giving a concrete next action. */
export function ImportFileError({ error }: { error: string }) {
  const damagedArchive = /end of central directory|Corrupted zip|not a zip file|invalid zip|unexpected end of (?:file|data)/i.test(error);
  if (!damagedArchive) return <p role="alert" style={{ color: 'var(--status-error)' }}>{error}</p>;
  return <div role="alert" style={{ color: 'var(--status-error)' }}>
    <p>这份 EPUB 无法打开，可能已损坏或没有下载完整。请重新下载后再检查；也可以点击本文件的“移出本批”，先导入其余书籍。已导入的书会保留。</p>
    <details><summary>查看错误详情</summary><p className="small">{error}</p></details>
  </div>;
}
