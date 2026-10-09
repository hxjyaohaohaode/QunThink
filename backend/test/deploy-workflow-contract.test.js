import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const root = fileURLToPath(new URL('../../', import.meta.url));
const workflow = YAML.parse(fs.readFileSync(path.join(root, '.github/workflows/deploy.yml'), 'utf8'));
const job = workflow.jobs.deploy;
const deploy = job.steps.find(step => step.name === 'Deploy to Render');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qunthink-deploy-contract-'));
const childEnv = {
  PATH: process.env.PATH,
  HOME: workDir,
  USERPROFILE: workDir,
  TEMP: workDir,
  TMP: workDir,
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: path.join(workDir, 'empty-git-config'),
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
};
fs.writeFileSync(childEnv.GIT_CONFIG_GLOBAL, '');
test.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: workDir, env: childEnv, encoding: 'utf8', timeout: 5000, maxBuffer: 128 * 1024,
    ...options,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}

const gitPath = run('bash', ['--noprofile', '--norc', '-c', 'command -v git']).stdout.trim();
assert.ok(gitPath, 'Git must be available for the local workflow shell test');

function fixture(message, { remoteMatches = true, failShow = false, apiKey = 'test-only-key', serviceId = 'test-only-service' } = {}) {
  const dir = fs.mkdtempSync(path.join(workDir, 'case-'));
  const git = args => {
    const result = run(gitPath, args, { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-q']);
  fs.writeFileSync(path.join(dir, 'message.txt'), `${message}\n\nPRIVATE_COMMIT_BODY\n`);
  git(['-c', 'user.name=Workflow Test', '-c', 'user.email=workflow-test@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '--cleanup=verbatim', '-q', '-F', 'message.txt']);
  const sha = git(['rev-parse', 'HEAD']);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  // Only these two git operations are allowed. No remote or deployment API is contacted.
  fs.writeFileSync(path.join(bin, 'git'), `#!/usr/bin/env bash
set -eu
if [[ "$#" == 3 && "$1" == ls-remote && "$2" == origin && "$3" == refs/heads/main ]]; then
  printf 'ls-remote\\n' >> "$MOCK_TRACE"
  printf '%s\\trefs/heads/main\\n' "$MOCK_REMOTE_SHA"
elif [[ "$#" == 4 && "$1" == show && "$2" == -s && "$3" == --format=%B && "$4" == "$TESTED_SHA" ]]; then
  printf 'show\\n' >> "$MOCK_TRACE"
  if [[ "$MOCK_FAIL_SHOW" == 1 ]]; then exit 7; fi
  exec "$REAL_GIT" "$@"
else
  echo 'Unexpected git operation in deployment test' >&2
  exit 99
fi
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'curl'), `#!/usr/bin/env bash
set -eu
printf 'curl\\n' >> "$MOCK_TRACE"
printf '%s\\0' "$@" >> "$MOCK_CURL_ARGS"
`, { mode: 0o755 });
  const script = path.join(dir, 'deploy.sh');
  fs.writeFileSync(script, deploy.run);
  const env = {
    ...childEnv,
    PATH: `${bin}${path.delimiter}${childEnv.PATH}`,
    REAL_GIT: gitPath,
    TESTED_SHA: sha,
    MOCK_REMOTE_SHA: remoteMatches ? sha : '0'.repeat(40),
    MOCK_FAIL_SHOW: failShow ? '1' : '0',
    MOCK_TRACE: path.join(dir, 'trace'),
    MOCK_CURL_ARGS: path.join(dir, 'curl-args'),
    HOSTILE_SENTINEL: path.join(dir, 'hostile-executed'),
    RENDER_API_KEY: apiKey,
    RENDER_SERVICE_ID: serviceId,
  };
  // This is the actual YAML run block under the default Ubuntu Actions bash -e shell.
  const result = run('bash', ['--noprofile', '--norc', '-e', script], { cwd: dir, env });
  const read = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const output = result.stdout + result.stderr;
  assert.doesNotMatch(output, /PRIVATE_COMMIT_BODY|test-only-key|test-only-service/);
  assert.equal(fs.existsSync(env.HOSTILE_SENTINEL), false, 'commit text must never execute');
  return {
    ...result, sha, output,
    trace: read(env.MOCK_TRACE).trim().split('\n').filter(Boolean),
    curlArgs: read(env.MOCK_CURL_ARGS).split('\0').filter(Boolean),
  };
}

function skipped(result, expectedTrace = ['ls-remote', 'show']) {
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.trace, expectedTrace);
  assert.deepEqual(result.curlArgs, []);
}

function deployed(result) {
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.trace, ['ls-remote', 'show', 'curl']);
  assert.deepEqual(result.curlArgs, [
    '--fail', '--show-error', '--silent', '-X', 'POST',
    '-H', 'Authorization: Bearer test-only-key',
    '-H', 'Content-Type: application/json',
    '-d', JSON.stringify({ commitId: result.sha }),
    'https://api.render.com/v1/services/test-only-service/deploys',
  ]);
}

test('deploy workflow preserves event, main, success, exact-SHA checkout and permission contracts', () => {
  assert.deepEqual(workflow.on, { workflow_run: { workflows: ['CI/CD Pipeline'], types: ['completed'] } });
  assert.equal(job.if, "github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push' && github.event.workflow_run.head_branch == 'main'");
  assert.equal(job['runs-on'], 'ubuntu-latest');
  assert.equal(workflow.permissions, undefined);
  assert.equal(job.permissions, undefined);
  assert.equal(job.steps.length, 2);
  assert.deepEqual(job.steps[0], {
    uses: 'actions/checkout@v4', with: { ref: '${{ github.event.workflow_run.head_sha }}' },
  });
  assert.deepEqual(deploy.env, {
    RENDER_API_KEY: '${{ secrets.RENDER_API_KEY }}',
    RENDER_SERVICE_ID: '${{ secrets.RENDER_SERVICE_ID }}',
    TESTED_SHA: '${{ github.event.workflow_run.head_sha }}',
  });
  const ordered = [
    'git ls-remote origin refs/heads/main',
    'if [ "$main_sha" != "$TESTED_SHA" ]',
    'git show -s --format=%B "$TESTED_SHA"',
    'case "${commit_message,,}" in',
    'if [ -z "$RENDER_API_KEY" ]',
    'if [ -z "$RENDER_SERVICE_ID" ]',
    'curl --fail --show-error --silent',
  ].map(fragment => {
    const index = deploy.run.indexOf(fragment);
    assert.notEqual(index, -1, fragment);
    return index;
  });
  assert.deepEqual(ordered, [...ordered].sort((a, b) => a - b));
  assert.doesNotMatch(deploy.run, /\$\{\{/);
  assert.equal(run('bash', ['--noprofile', '--norc', '-n'], { input: deploy.run }).status, 0);
});

// https://render.com/docs/deploys#skipping-an-auto-deploy
for (const phrase of ['skip render', 'render skip', 'skip deploy', 'deploy skip', 'skip cd', 'cd skip']) {
  for (const uppercase of [false, true]) {
    for (const body of [false, true]) {
      test(`skip phrase [${phrase}] in ${uppercase ? 'uppercase' : 'lowercase'} ${body ? 'body' : 'subject'} makes zero deploy calls`, () => {
        const marker = `[${uppercase ? phrase.toUpperCase() : phrase}]`;
        const result = fixture(body ? `Routine change\n\nDetails ${marker}` : `Routine change ${marker}`);
        skipped(result);
        assert.equal(result.stdout.trim(), 'Tested commit requests a deployment skip; skipping Render deployment');
      });
    }
  }
}

test('mixed-case skip markers are recognized before missing credentials', () => {
  const result = fixture('Routine change\n\n[SkIp ReNdEr]', { apiKey: '', serviceId: '' });
  skipped(result);
  assert.match(result.output, /^Tested commit requests a deployment skip;/);
  assert.doesNotMatch(result.output, /secret/);
});

test('a normal commit deploys the tested SHA exactly once', () => deployed(fixture('Routine change')));

test('unrelated bracket text is not treated as a deployment skip', () => {
  deployed(fixture('[skip tests] [skip ci] [skip rendering] [render skipped] [skip  deploy]'));
});

test('a stale tested SHA exits before reading its message or calling curl', () => {
  skipped(fixture('Routine change', { remoteMatches: false, failShow: true }), ['ls-remote']);
});

for (const field of ['apiKey', 'serviceId']) {
  test(`missing ${field} makes zero deploy calls`, () => skipped(fixture('Routine change', { [field]: '' })));
}

test('failed commit-message lookup fails closed with no deploy call', () => {
  const result = fixture('Routine change', { failShow: true });
  assert.equal(result.status, 1);
  assert.deepEqual(result.trace, ['ls-remote', 'show']);
  assert.deepEqual(result.curlArgs, []);
  assert.equal(result.stdout.trim(), '::error::Unable to read tested commit message; refusing Render deployment');
});

test('hostile command substitution and backticks in commit text remain inert', () => {
  const hostile = 'Routine change\n\n$(printf compromised > "$HOSTILE_SENTINEL") `printf compromised > "$HOSTILE_SENTINEL"`';
  deployed(fixture(hostile));
  skipped(fixture(`${hostile}\n[skip render]`));
});
