import AdmZip from 'adm-zip';

// Receives only the canonical, actually expanded-budget-checked archive.
export async function extractZipText(buffer, format, basename) {
  if (format === 'archive') {
    return `\n包含文件:\n${buffer.slice(0, 50).join('\n')}${buffer.length > 50 ? `\n... 共 ${buffer.length} 个文件` : ''}`;
  }
  if (format === 'xlsx') {
    const MAX_ROWS = 10000, MAX_SHEETS = 20, MAX_COLUMNS = 100;
    const { default: ExcelJS } = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    let result = '';
    let totalRows = 0;

    for (const worksheet of workbook.worksheets.slice(0, MAX_SHEETS)) {
      if (totalRows >= MAX_ROWS) break;
      const sheetLines = [];
      const rowLimit = Math.min(Number(worksheet.rowCount) || 0, MAX_ROWS - totalRows);
      for (let rowNumber = 1; rowNumber <= rowLimit; rowNumber += 1) {
        const row = worksheet.getRow(rowNumber);
        const values = row.values.slice(1, MAX_COLUMNS + 1).map(cell => {
          if (cell === null || cell === undefined) return '';
          if (typeof cell === 'object') {
            if (typeof cell.text === 'string') return cell.text;
            if (Object.prototype.hasOwnProperty.call(cell, 'result')) return String(cell.result ?? '');
            return '';
          }
          return String(cell);
        });
        sheetLines.push(values.join('\t'));
        totalRows += 1;
      }
      result += `--- Sheet: ${worksheet.name} ---\n${sheetLines.join('\n')}\n\n`;
    }

    return totalRows >= MAX_ROWS
      ? `解析表格（仅显示前${MAX_ROWS}行）：\n${result}`
      : result;

  }
  const zip = new AdmZip(buffer);
  if (format === 'pptx') {
    const entries = zip.getEntries().filter(e => /^ppt\/slides\/slide\d+\.xml$/i.test(e.entryName))
      .sort((a, b) => parseInt(a.entryName.match(/slide(\d+)/i)[1]) - parseInt(b.entryName.match(/slide(\d+)/i)[1]));
    let result = '';
    for (const entry of entries) {
      const texts = [...entry.getData().toString('utf8').matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)].map(m => m[1].trim()).filter(Boolean);
      if (texts.length) result += `--- 幻灯片 ${entry.entryName.match(/slide(\d+)/i)[1]} ---\n${texts.join('\n')}\n\n`;
    }
    return result.trim() || `[PPT文件: ${basename}, 格式: .PPTX]`;
  }
  if (['epub', 'mobi'].includes(format)) {
    let result = '';
    const entries = zip.getEntries().filter(e => /\.(html|xhtml|htm)$/.test(e.entryName));
    for (const entry of entries.slice(0, 20)) {
      const text = entry.getData().toString('utf8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (text) result += text + '\n\n';
      if (result.length > 5000) break;
    }
    return result.trim() || `[电子书文件] 名称=${basename} · 格式=.${format.toUpperCase()}`;
  }
  if (['odt', 'ods', 'odp'].includes(format)) {
    const entry = zip.getEntries().find(e => e.entryName === 'content.xml');
    if (entry) {
      const texts = [...entry.getData().toString('utf8').matchAll(/<text:p[^>]*>([^<]*(?:<[^>]+>[^<]*)*)<\/text:p>/g)]
        .map(m => m[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean);
      if (texts.length) return texts.join('\n');
    }
    const label = format === 'odt' ? 'ODT文档' : format === 'ods' ? 'ODS表格' : 'ODP演示';
    return `[${label}] 名称=${basename} · 格式=.${format.toUpperCase()}`;
  }
  throw new Error('Unsupported ZIP document format');
}
