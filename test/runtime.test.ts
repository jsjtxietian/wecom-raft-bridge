import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { controlFile, controlPort, openControl, readStatus, requestStop } from '../scripts/runtime.mjs';
import { runCommand } from '../scripts/bridge.mjs';

async function directory(t: TestContext) {
  const parent = resolve(tmpdir()), root = await mkdtemp(join(parent, 'wecom-runtime 空格 '));
  t.after(async () => {
    assert.equal(dirname(root), parent);
    assert.ok(basename(root).startsWith('wecom-runtime 空格 '));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('a live control port prevents concurrent owners; stop requires its current token', async t => {
  const root = await directory(t);
  const control = await openControl(root, { onStop: async () => { await control.close(); } });
  try {
    const attempts = await Promise.allSettled([openControl(root, { onStop() {} }), openControl(root, { onStop() {} })]);
    assert.ok(attempts.every(result => result.status === 'rejected'));
    control.update('ready');
    assert.equal((await readStatus(root))!.phase, 'ready');
    const saved = await readFile(controlFile(root), 'utf8');
    await writeFile(controlFile(root), JSON.stringify({ ...JSON.parse(saved), token: 'stale-token' }));
    await assert.rejects(requestStop(root), /停止凭据已失效/);
    assert.ok(await readStatus(root));
    await writeFile(controlFile(root), saved);
  } finally { await control.close(); }
  assert.equal(await readStatus(root), null);
});

test('stale PID records never stop unrelated processes, and a new owner replaces stale state', async t => {
  const root = await directory(t);
  await mkdir(join(root, '.local'));
  await writeFile(controlFile(root), JSON.stringify({ pid: process.pid, token: 'stale' }));
  assert.equal(await requestStop(root), false);
  const control = await openControl(root, { onStop() {} });
  try { assert.notEqual(JSON.parse(await readFile(controlFile(root), 'utf8')).token, 'stale'); }
  finally { await control.close(); }
});

test('a foreign service on the control port is left untouched', async t => {
  const root = await directory(t);
  let stopped = false;
  const other = createServer((req, res) => { if (req.url === '/stop') stopped = true; res.end('{}'); });
  await new Promise<void>(resolve => other.listen(controlPort(root), '127.0.0.1', resolve));
  try { await assert.rejects(requestStop(root), /其他程序/); assert.equal(stopped, false); }
  finally { await new Promise<void>(resolve => other.close(() => resolve())); }
});

test('background launcher handles spaces, duplicate starts, status and graceful stop using a mock worker', async t => {
  const root = await directory(t), output: string[] = [];
  const options = { root, entry: fileURLToPath(new URL('./fixtures/runtime-worker.mjs', import.meta.url)),
    output: (line: string) => output.push(line) };
  await writeFile(join(root, '.env'), '');
  try {
    await runCommand('start', options);
    const pid = (await readStatus(root))!.pid;
    await runCommand('start', options);
    assert.equal((await readStatus(root))!.pid, pid);
    await runCommand('status', options);
    assert.ok(output.some(line => line.includes('企微已认证')));
    await runCommand('stop', options);
    assert.equal(await readStatus(root), null);
    await runCommand('stop', options);
    assert.ok(output.includes('已停止。'));
    assert.ok(output.includes('未运行，无需停止。'));
    assert.equal(await readFile(join(root, '.local', 'bridge.stdout.log'), 'utf8'), '');
  } finally {
    if (await readStatus(root)) await runCommand('stop', options);
  }
});
