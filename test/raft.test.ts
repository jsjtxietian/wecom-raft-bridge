import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RaftConnection } from '../src/raft.js';
import { parseConfig } from '../src/config.js';

const cfg = parseConfig('run', { WECOM_BOT_ID: 'test-bot', WECOM_SECRET: 'test-secret',
  RAFT_SERVER_URL: 'https://raft.example.test', RAFT_AGENT_CREDENTIAL: 'sk_agent_test',
  RAFT_CHANNEL: '#test', RAFT_TARGET_AGENT: '@Sol', RAFT_EXPECTED_AGENT: '@WeCom' });

test('actual Raft SDK uploads bytes as multipart to the resolved conversation and returns attachment id', async () => {
  const calls: string[] = [];
  const raft = new RaftConnection(cfg, (async (url, init) => {
    const path = new URL(String(url)).pathname; calls.push(path);
    if (path.endsWith('/attachment-upload-capabilities')) return Response.json({
      directUploadEnabled: false, directUploadThresholdBytes: null, maxBytes: 15 * 1024 * 1024, sessionExpiresInSeconds: null,
    });
    if (path.endsWith('/resolve-channel')) {
      assert.equal(JSON.parse(String(init!.body)).target, '#test:root-mes');
      return Response.json({ channelId: 'resolved-thread' });
    }
    if (path.endsWith('/upload')) {
      assert.equal(new Headers(init!.headers).get('authorization'), 'Bearer sk_agent_test');
      assert.ok(init && init.body instanceof FormData);
      assert.equal(init.body.get('channelId'), 'resolved-thread');
      const file = init.body.get('file'); assert.ok(file instanceof Blob);
      assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [1, 2, 3]);
      assert.equal(file.type, 'image/png');
      return Response.json({ id: 'attachment-id', filename: 'image-1.png', mimeType: 'image/png', sizeBytes: 3, thumbnailUrl: null });
    }
    throw new Error(`Unexpected route ${path}`);
  }) as typeof fetch);
  const id = await raft.uploadImage({ filename: 'image-1.png', bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' }, 'root-message');
  assert.equal(id, 'attachment-id');
  assert.equal(calls.length, 3);
});

test('image message sends use the actual program client attachmentIds field and stable idempotency key', async () => {
  const requests: Record<string, any>[] = [];
  const raft = new RaftConnection(cfg, (async (_url, init) => {
    if (init?.method === 'POST') {
      requests.push(JSON.parse(String(init.body)));
      return Response.json({ error: 'test send refused' }, { status: 403 });
    }
    throw new Error('Unexpected read');
  }) as typeof fetch);
  await assert.rejects(raft.send('@Sol\n\n这是什么？', 'source-id', 'root-message', ['attachment-id']));
  await assert.rejects(raft.send('@Sol\n\n这是什么？', 'source-id', 'root-message', ['attachment-id']));
  assert.equal(requests.length, 2);
  assert.equal(requests[0]!.target, '#test:root-mes');
  assert.deepEqual(requests[0]!.attachmentIds, ['attachment-id']);
  assert.equal(requests[0]!.idempotencyKey, requests[1]!.idempotencyKey);
});
