import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseConfig } from '../src/config.js';
import { PrivateSessions } from '../src/private-sessions.js';

const cfg = parseConfig('run', { WECOM_BOT_ID: 'test-bot', WECOM_SECRET: 'test-secret-not-stored',
  RAFT_SERVER_URL: 'https://example.test', RAFT_AGENT_CREDENTIAL: 'test-credential-not-stored',
  RAFT_CHANNEL: '#test', RAFT_TARGET_AGENT: '@Sol', RAFT_EXPECTED_AGENT: '@WeCom' });
const session = { userId: 'user-A', rootMessageId: 'root-A', firstSourceId: 'source-A' };
async function directory(t: TestContext) {
  const parent = resolve(tmpdir());
  const dir = await mkdtemp(join(parent, 'raft-wecom-session-'));
  t.after(async () => {
    assert.equal(dirname(dir), parent);
    assert.ok(basename(dir).startsWith('raft-wecom-session-'));
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('private routes survive reload without storing credentials or conversation text', async t => {
  const dir = await directory(t), store = await PrivateSessions.load(cfg, dir);
  store.remember(session); await store.flush();
  const restored = await PrivateSessions.load(cfg, dir);
  assert.deepEqual(restored.get('user-A'), session);
  const saved = await readFile(store.file!, 'utf8');
  assert.ok(!saved.includes(cfg.secret)); assert.ok(!saved.includes(cfg.credential));
  assert.deepEqual(Object.keys(JSON.parse(saved).sessions[0]).sort(), ['firstSourceId', 'rootMessageId', 'userId']);
  restored.remember({ userId: 'user-B', rootMessageId: 'root-B', firstSourceId: 'source-B' });
  await restored.flush();
  assert.equal((await PrivateSessions.load(cfg, dir)).all().length, 2);
});

test('bot, server, channel and agent changes cannot reuse another routing scope', async t => {
  const dir = await directory(t), store = await PrivateSessions.load(cfg, dir);
  store.remember(session); await store.flush();
  for (const change of [{ botId: 'other-bot' }, { serverUrl: 'https://other.test' },
    { channel: '#other' }, { expectedAgent: '@OtherBridge' }, { targetAgent: '@OtherWorker' }]) {
    assert.equal((await PrivateSessions.load({ ...cfg, ...change }, dir)).all().length, 0);
  }
  assert.deepEqual((await PrivateSessions.load({ ...cfg, credential: 'rotated' }, dir)).get('user-A'), session);
});

test('corrupt state or conflicting destinations fail closed and preserve the file', async t => {
  const dir = await directory(t), store = await PrivateSessions.load(cfg, dir);
  store.remember(session); await store.flush();
  const saved = JSON.parse(await readFile(store.file!, 'utf8'));
  for (const source of ['{truncated', JSON.stringify({ ...saved, version: 999 }),
    JSON.stringify({ ...saved, sessions: [session, { ...session, userId: 'user-B' }] })]) {
    await writeFile(store.file!, source);
    await assert.rejects(PrivateSessions.load(cfg, dir), /映射文件无效/);
    assert.equal(await readFile(store.file!, 'utf8'), source);
  }
});

test('a failed save retains the accepted mapping and succeeds after the storage problem is fixed', async t => {
  const dir = await directory(t), parent = join(dir, 'parent');
  await writeFile(parent, 'blocks directory creation');
  const store = new PrivateSessions(join(parent, 'sessions.json'));
  store.remember(session);
  await assert.rejects(store.flush(), /无法保存/);
  assert.deepEqual(store.get('user-A'), session);
  await rename(parent, join(dir, 'former-blocker'));
  await store.flush();
  assert.deepEqual(JSON.parse(await readFile(store.file!, 'utf8')).sessions, [session]);
});

test('reset survives reload before and after the next task, retaining old reply routes and reset dedupe', async t => {
  const dir = await directory(t), store = await PrivateSessions.load(cfg, dir);
  store.remember(session); await store.flush();
  await store.reset('user-A', 'reset-A');
  const empty = await PrivateSessions.load(cfg, dir);
  assert.equal(empty.get('user-A'), undefined);
  assert.deepEqual(empty.routes(), [session]);
  assert.ok(empty.hasFirstSource('source-A'));
  assert.ok(empty.hasReset('reset-A'));
  const next = { ...session, rootMessageId: 'new-root', firstSourceId: 'new-source' };
  empty.remember(next); await empty.flush();
  const restored = await PrivateSessions.load(cfg, dir);
  await restored.reset('user-A', 'reset-A');
  assert.deepEqual(restored.get('user-A'), next);
  assert.equal(restored.routes().length, 2);
});

test('failed reset write rolls back in memory and on disk; retry can commit the switch', async t => {
  const dir = await directory(t), store = await PrivateSessions.load(cfg, dir);
  store.remember(session); await store.flush();
  const saved = await readFile(store.file!, 'utf8');
  // A directory at the temporary file path makes writeFile fail on every OS.
  const { mkdir } = await import('node:fs/promises');
  const temporary = `${store.file}.${process.pid}.tmp`;
  await mkdir(temporary);
  await assert.rejects(store.reset('user-A', 'reset-A'), /无法保存/);
  assert.deepEqual(store.get('user-A'), session);
  assert.equal(store.hasReset('reset-A'), false);
  assert.equal(await readFile(store.file!, 'utf8'), saved);
  const { rmdir } = await import('node:fs/promises');
  await rmdir(temporary);
  await store.reset('user-A', 'reset-A');
  assert.equal((await PrivateSessions.load(cfg, dir)).get('user-A'), undefined);
});

test('version 1 private session files remain readable and migrate on the next write', async t => {
  const dir = await directory(t), store = await PrivateSessions.load(cfg, dir);
  store.remember(session); await store.flush();
  const data = JSON.parse(await readFile(store.file!, 'utf8'));
  await writeFile(store.file!, JSON.stringify({ version: 1, scope: data.scope, sessions: data.sessions }));
  const restored = await PrivateSessions.load(cfg, dir);
  assert.deepEqual(restored.get('user-A'), session);
  await restored.reset('user-A', 'reset-A');
  assert.equal(JSON.parse(await readFile(store.file!, 'utf8')).version, 2);
});
