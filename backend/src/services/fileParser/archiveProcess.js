import { fork } from 'node:child_process';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ARCHIVE_LIMITS } from './archiveBudget.js';

// Fail fast rather than retain an unbounded queue of uploads in memory.
export function createArchiveParser({ workerUrl = new URL('./archiveWorker.js', import.meta.url), timeoutMs = ARCHIVE_LIMITS.timeoutMs, concurrency = ARCHIVE_LIMITS.concurrency, snapshotRoot = os.tmpdir() } = {}) {
  let active = 0;
  return async function parseDocx(filePath, { signal, format = 'docx' } = {}) {
    if (signal?.aborted) throw new Error('Document parsing cancelled');
    if (active >= concurrency) throw new Error('Document parser busy');
    active++;
    let directory;
    let source;
    try {
      // Private immutable snapshot: the worker never receives an arbitrary caller
      // path, application credentials, or a file that can grow during parsing.
      if (!(await fs.lstat(filePath)).isFile()) throw new Error('Document input must be a regular file');
      source = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
      const stats = await source.stat();
      if (!stats.isFile() || stats.size > ARCHIVE_LIMITS.inputBytes) throw new Error('Document input budget exceeded');
      const input = Buffer.alloc(ARCHIVE_LIMITS.inputBytes + 1);
      let length = 0;
      while (length < input.length) {
        if (signal?.aborted) throw new Error('Document parsing cancelled');
        const { bytesRead } = await source.read(input, length, input.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      await source.close();
      source = undefined;
      if (length > ARCHIVE_LIMITS.inputBytes) throw new Error('Document input budget exceeded');
      directory = await fs.mkdtemp(path.join(snapshotRoot, 'qunthink-docx-'));
      const snapshot = path.join(directory, 'input.docx');
      await fs.writeFile(snapshot, input.subarray(0, length), { mode: 0o600 });
      if (signal?.aborted) throw new Error('Document parsing cancelled');
      return await new Promise((resolve, reject) => {
        let child;
        let timer;
        let failure;
        let outputBytes = 0;
        const chunks = [];
        const stop = (error) => { failure ??= error; child?.kill('SIGKILL'); };
        const abort = () => stop(new Error('Document parsing cancelled'));
        try {
          child = fork(workerUrl, [], {
            execArgv: ['--max-old-space-size=128'],
            stdio: ['ignore', 'pipe', 'ignore', 'ipc'],
            env: { NODE_ENV: 'production', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }
          });
          signal?.addEventListener('abort', abort, { once: true });
          timer = setTimeout(() => stop(new Error('Document parsing timed out')), timeoutMs);
          child.on('error', stop);
          child.stdout.on('error', stop);
          child.stdout.on('data', chunk => {
            outputBytes += chunk.length;
            if (outputBytes > ARCHIVE_LIMITS.outputBytes) stop(new Error('Document output budget exceeded'));
            else if (!failure) chunks.push(chunk);
          });
          // No result uses IPC: the streaming pipe is bounded before buffering.
          child.once('close', code => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            if (failure || code !== 0) reject(failure || new Error(code === 2 ? 'Document resource budget exceeded (entry 4MiB, expanded 8MiB, output 1MiB)' : 'Document parsing failed'));
            else resolve(Buffer.concat(chunks).toString('utf8'));
          });
          child.send({ filePath: snapshot, format, basename: path.basename(filePath) }, error => { if (error) stop(error); });
          if (signal?.aborted) abort();
        } catch (error) {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          if (child) stop(error);
          else reject(error);
        }
      });
    } finally {
      try {
        await source?.close();
        if (directory) await fs.rm(directory, { recursive: true, force: true });
      } finally { active--; }
    }
  };
}
export const parseBoundedArchive = createArchiveParser();
