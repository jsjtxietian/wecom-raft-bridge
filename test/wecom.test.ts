import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { createWecom, type TextFrame } from '../src/wecom.js';
import type { Config } from '../src/config.js';

test('official SDK authenticates, receives callbacks, replies with original req_id and sends to fixed chat', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const address = server.address(); assert.ok(typeof address === 'object' && address);
  const frames: Record<string, any>[] = [];
  server.on('connection', socket => socket.on('message', raw => {
    const frame = JSON.parse(raw.toString()); frames.push(frame);
    socket.send(JSON.stringify({ headers: frame.headers, errcode: 0, errmsg: 'ok' }));
    if (frame.cmd === 'aibot_subscribe') socket.send(JSON.stringify({ cmd: 'aibot_msg_callback',
      headers: { req_id: 'original-request' }, body: { msgid: 'message-1', aibotid: 'bot-1', chatid: 'group-1',
        chattype: 'group', from: { userid: 'person-1' }, msgtype: 'text', text: { content: 'hello' } } }));
  }));
  const { client, port } = createWecom({ botId: 'bot-1', secret: 'fake-secret' } as Config, `ws://127.0.0.1:${address.port}`);
  try {
    const received = new Promise<TextFrame>(resolve => client.once('message.text', resolve));
    client.connect();
    const frame = await received;
    await port.acknowledge(frame, '已交给 @Sol。');
    await port.send('group-1', '[Sol] hello');
    assert.equal(frames[0]!.body.bot_id, 'bot-1');
    const ack = frames.find(f => f.cmd === 'aibot_respond_msg')!;
    assert.equal(ack.headers.req_id, 'original-request');
    assert.equal(ack.body.stream.finish, true);
    assert.equal(ack.body.stream.content, '已交给 @Sol。');
    assert.equal(frames.filter(f => f.cmd === 'aibot_respond_msg').length, 1);
    const push = frames.find(f => f.cmd === 'aibot_send_msg')!;
    assert.equal(push.body.chatid, 'group-1');
    assert.equal(push.body.markdown.content, '[Sol] hello');
  } finally {
    client.disconnect();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
