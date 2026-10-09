import fs from 'node:fs/promises';
import mammoth from 'mammoth';
import { extractZipText } from './zipText.js';
import { boundedZipArchive, ARCHIVE_LIMITS } from './archiveBudget.js';

// No inherited application imports, credentials, DB, or network access is needed.
process.once('message', async ({ filePath, format = 'docx', basename }) => {
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > ARCHIVE_LIMITS.inputBytes) throw new Error('Document input budget exceeded');
    // Bounded read also covers a file growing between stat and read.
    const input = Buffer.alloc(ARCHIVE_LIMITS.inputBytes + 1);
    let length = 0;
    while (length < input.length) {
      const { bytesRead } = await handle.read(input, length, input.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > ARCHIVE_LIMITS.inputBytes) throw new Error('Document input budget exceeded');
    const buffer = boundedZipArchive(input.subarray(0, length), { requiredEntry: format === 'docx' ? 'word/document.xml' : undefined, listOnly: format === 'archive' });
    const value = format === 'docx'
      ? (await mammoth.extractRawText({ buffer }, { externalFileAccess: false })).value || ''
      : await extractZipText(buffer, format, basename);
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > ARCHIVE_LIMITS.outputBytes) throw Object.assign(new Error('Document output budget exceeded'), { code: 'DOCUMENT_BUDGET' });
    await new Promise((resolve, reject) => process.stdout.write(value, error => error ? reject(error) : resolve()));
  } catch (error) {
    process.exitCode = ['DOCUMENT_BUDGET', 'ERR_BUFFER_TOO_LARGE'].includes(error.code) ? 2 : 1;
  } finally {
    await handle?.close();
    process.disconnect();
  }
});
