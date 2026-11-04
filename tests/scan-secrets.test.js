import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const run = promisify(execFile);
const scanner = resolve('scripts/scan-secrets.py');
const synthetic = 'sk-' + 'A'.repeat(40); // Fake fixture, assembled to avoid scanning the test source itself.
async function repository(t) {
  const directory = await mkdtemp(join(tmpdir(), 'openai-proxy-scan-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
    '-c', 'user.name=Local test', '-c', 'user.email=test@example.invalid', ...args], { cwd: directory });
  await git('init', '-q');
  const write = (name, text) => writeFile(join(directory, name), text);
  const scan = () => run('python3', [scanner], { cwd: directory })
    .then(r => ({ ...r, code: 0 }), e => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));
  return { directory, git, write, scan };
}
function detected(result, location) {
  assert.equal(result.code, 1);
  assert.match(result.stdout, location);
  assert.ok(!result.stdout.includes(synthetic) && !result.stderr.includes(synthetic), 'credential values must stay redacted');
}

test('secret scan accepts a clean staged file before the first commit', async t => {
  const r = await repository(t); await r.write('config.txt', 'safe\n'); await r.git('add', 'config.txt');
  assert.equal((await r.scan()).code, 0);
});
test('secret scan detects staged credentials even after working copy is cleaned', async t => {
  const r = await repository(t);
  const name = 'config\twith spaces.txt';
  await r.write(name, synthetic); await r.git('add', name); await r.write(name, 'safe\n');
  detected(await r.scan(), /index:/);
});
test('secret scan detects staged credentials when working file has been removed', async t => {
  const r = await repository(t); await r.write('config.txt', synthetic); await r.git('add', 'config.txt');
  await rm(join(r.directory, 'config.txt'));
  detected(await r.scan(), /index:/);
});
test('secret scan still detects untracked working files', async t => {
  const r = await repository(t); await r.write('untracked.txt', synthetic);
  detected(await r.scan(), /working tree:/);
});
test('secret scan still detects credentials removed from reachable history', async t => {
  const r = await repository(t); await r.write('config.txt', synthetic); await r.git('add', 'config.txt');
  await r.git('commit', '-qm', 'fixture');
  await r.write('config.txt', 'safe\n'); await r.git('add', 'config.txt'); await r.git('commit', '-qm', 'clean');
  detected(await r.scan(), /history:/);
});
