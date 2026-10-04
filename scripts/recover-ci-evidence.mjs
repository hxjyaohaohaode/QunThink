import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { splitArchive } from './pack-ci-evidence.mjs';

export const RECOVERY_REPOSITORY = 'hxjyaohaohaode/QunThink';
export const RECOVERY_RUN_ID = 37228163396;
export const RECOVERY_HEAD_SHA = '154a3bd53d2b0087177d944fc186afcd368e6ea6';
export const RECOVERY_ARTIFACTS = Object.freeze({
  'desktop-chromium': Object.freeze({ id: 11312347977, bytes: 53769687, sha256: 'd0a837b5034318a74f56de07baa17d13a73cfdba28cfddaeac24552b18da104c' }),
  'mobile-reduced-motion': Object.freeze({ id: 11313221243, bytes: 39518533, sha256: '19602f41df35e08fe4177406689ab5bd38271dad7d5fd05815ffa6884ddf6707' }),
});

export function validateOriginalMetadata(metadata, project) {
  const expected = RECOVERY_ARTIFACTS[project];
  if (!expected || metadata.id !== expected.id || metadata.workflow_run?.id !== RECOVERY_RUN_ID ||
      metadata.workflow_run.head_sha !== RECOVERY_HEAD_SHA ||
      metadata.name !== `qunthink-browser-evidence-${project}` || metadata.expired !== false ||
      metadata.size_in_bytes !== expected.bytes || metadata.digest !== `sha256:${expected.sha256}`) {
    throw new Error('Original evidence metadata does not match the exact approved, unexpired artifact');
  }
  return expected;
}

export function validateOriginalBytes(data, expected) {
  if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) throw new Error('GitHub did not return a binary artifact archive');
  const bytes = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (bytes.length !== expected.bytes || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) {
    throw new Error('Original evidence ZIP failed the pinned byte-count/SHA-256 check');
  }
  return bytes;
}

// Called only inside the official actions/github-script action, whose Octokit
// client uses the built-in ephemeral token. No token or signed download URL is
// accepted, serialized, printed, or passed to another tool by this module.
export async function recoverKnownArtifact({ github, context, project, outputDir }) {
  if (process.env.GITHUB_ACTIONS !== 'true' || !/^\d+$/.test(process.env.GITHUB_RUN_ID || '') ||
      process.env.GITHUB_REPOSITORY !== RECOVERY_REPOSITORY || context.eventName !== 'pull_request' ||
      context.payload.pull_request?.number !== 1 || !RECOVERY_ARTIFACTS[project]) {
    throw new Error('Original evidence recovery is restricted to the authorized repository PR #1 CI job');
  }
  const [owner, repo] = RECOVERY_REPOSITORY.split('/');
  const parameters = { owner, repo, artifact_id: RECOVERY_ARTIFACTS[project].id };
  let metadata;
  try { metadata = (await github.rest.actions.getArtifact(parameters)).data; }
  catch (error) { throw new Error(`GitHub artifact metadata read failed (HTTP ${Number(error.status) || 'unknown'}); no alternate route attempted`); }
  const expected = validateOriginalMetadata(metadata, project);
  let data;
  try { data = (await github.rest.actions.downloadArtifact({ ...parameters, archive_format: 'zip' })).data; }
  catch (error) { throw new Error(`GitHub artifact download failed (HTTP ${Number(error.status) || 'unknown'}); no alternate route attempted`); }
  const bytes = validateOriginalBytes(data, expected);
  const temporary = await mkdtemp(path.join(tmpdir(), 'qunthink-original-evidence-'));
  try {
    const input = path.join(temporary, `original-artifact-${expected.id}.zip`);
    await writeFile(input, bytes, { flag: 'wx' });
    return await splitArchive({ input, outputDir, source: {
      kind: 'original-github-artifact-byte-for-byte', format: 'zip', repository: RECOVERY_REPOSITORY,
      runId: RECOVERY_RUN_ID, artifactId: expected.id, artifactName: metadata.name,
      originalHeadSha: metadata.workflow_run.head_sha, originalCreatedAt: metadata.created_at,
      originalArchiveBytes: expected.bytes, originalArchiveSha256: expected.sha256,
      recoveryRunId: process.env.GITHUB_RUN_ID, recoveryRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
      project,
    } });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
