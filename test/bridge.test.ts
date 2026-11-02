import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RaftEvent, RaftEventsReceiveData } from '@botiverse/raft-sdk';
import { Bridge, belongsToChannel } from '../src/bridge.js';
import type { Config } from '../src/config.js';
import { cleanText, splitText, type TextFrame, type WecomPort } from '../src/wecom.js';
import type { RaftPort } from '../src/raft.js';

export const cfg: Config = { botId: 'bot-id', secret: 'test-secret', botName: '桥接机器人', chatId: 'group-1',
  serverUrl: 'https://example.test', credential: 'sk_agent_test', channel: '#StoryLoom_Wecom',
  targetAgent: '@Sol', expectedAgent: '@WeCom', pollMs: 2000 };
const frame = (id = 'source-1'): TextFrame => ({ headers: { req_id: 'request-1' }, body: {
  msgid: id, aibotid: cfg.botId, chatid: cfg.chatId, chattype: 'group', from: { userid: 'person-1' },
  msgtype: 'text', text: { content: '@桥接机器人 请检查 a@b.com 和 @另一个人' },
} } as TextFrame);
const event = (overrides: Partial<RaftEvent> = {}): RaftEvent => ({ type: 'message', messageId: 'reply-1',
  timestamp: new Date(Date.now() + 1000).toISOString(), senderType: 'agent', senderName: 'Sol',
  content: '任务完成', channelName: 'StoryLoom_Wecom', channelType: 'channel', attachments: [], ...overrides });
function setup(events: RaftEvent[] = []) {
  const calls: string[] = [], cursors: (number | undefined)[] = [], posts: { body: string; key: string }[] = [];
  const raft: RaftPort = {
    async send(body, key) { calls.push('raft'); posts.push({ body, key }); return 'raft-1'; },
    async receive(cursor) { cursors.push(cursor); return { events, lastSeenSeq: 42, ackMode: 'cursor', hasMore: false,
      lastSeenMessageId: null, replyTarget: null } satisfies RaftEventsReceiveData; },
  };
  const wecom: WecomPort = { async acknowledge(_frame, text) { calls.push(text); }, async send(_chat, text) { calls.push(text); } };
  return { calls, posts, cursors, raft, wecom, bridge: new Bridge(cfg, raft, wecom, async () => {}) };
}

test('only strips configured leading bot mention and preserves task text', () => {
  assert.equal(cleanText('@桥接机器人\u2005检查 user@example.com 和 @Sol', 'id', '桥接机器人'), '检查 user@example.com 和 @Sol');
  assert.equal(cleanText('<@id> hello', 'id', ''), 'hello');
  assert.equal(cleanText('@id-extra hi', 'id', ''), '@id-extra hi');
  assert.equal(cleanText('代码里的 @桥接机器人', 'id', '桥接机器人'), '代码里的 @桥接机器人');
});
test('UTF-8 splitting preserves Chinese and emoji', () => {
  const input = '你好🌍'.repeat(1600), parts = splitText(input);
  assert.equal(parts.join(''), input);
  assert.ok(parts.every(part => Buffer.byteLength(part) <= 3500));
});
test('one confirmation after Raft succeeds, plain task and concurrent deduplication', async () => {
  const s = setup();
  let confirmSend!: (messageId: string) => void;
  const sent = new Promise<string>(resolve => { confirmSend = resolve; });
  const originalSend = s.raft.send;
  s.raft.send = async (body, key) => { await originalSend(body, key); return sent; };
  const first = s.bridge.accept(frame()), duplicate = s.bridge.accept(frame());
  await Promise.resolve();
  assert.deepEqual(s.calls, ['raft']);
  confirmSend('raft-1');
  await Promise.all([first, duplicate]);
  await s.bridge.accept(frame());
  assert.deepEqual(s.calls, ['raft', '已交给 @Sol。']);
  assert.equal(s.posts[0]!.body, '@Sol\n\n请检查 a@b.com 和 @另一个人');
  assert.equal(s.posts.length, 1);
});
test('wrong group, bot and private messages never enter Raft', async () => {
  const s = setup();
  for (const patch of [{ chatid: 'other' }, { chattype: 'single' }, { aibotid: 'other' }]) {
    const f = frame(); Object.assign(f.body!, patch); await s.bridge.accept(f);
  }
  assert.equal(s.calls.length, 0);
});
test('failure retries use the same key and never claim submission', async () => {
  const s = setup(), keys: string[] = [];
  s.raft.send = async (_body, key) => { keys.push(key); throw new Error('timeout'); };
  await s.bridge.accept(frame());
  assert.equal(keys.length, 3); assert.equal(new Set(keys).size, 1);
  assert.equal(s.calls.length, 1);
  assert.ok(s.calls.every(text => !text.startsWith('已交给')));
});
test('notification failure does not resend accepted Raft request', async () => {
  const s = setup(); s.wecom.acknowledge = async () => { throw new Error('disconnect'); };
  await s.bridge.accept(frame()); await s.bridge.accept(frame());
  assert.equal(s.posts.length, 1);
});
test('only new agent replies from the fixed channel or its threads are returned', async () => {
  const s = setup([event(), event({ messageId: 'thread', channelType: 'thread', channelName: 'abc123',
    parentChannelType: 'channel', parentChannelName: 'StoryLoom_Wecom', senderName: 'Collaborator' }),
    event({ senderName: 'WeCom' }), event({ senderType: 'human' }), event({ senderType: 'system' }),
    event({ channelName: 'elsewhere' }), event({ timestamp: '2000-01-01T00:00:00Z' }), event({ timestamp: 'invalid' })]);
  await s.bridge.poll(); await s.bridge.poll();
  assert.deepEqual(s.calls, ['[Sol] 任务完成', '[Collaborator] 任务完成']);
  assert.deepEqual(s.cursors, [undefined, 42]);
  assert.equal(belongsToChannel(event({ channelType: 'dm' }), cfg.channel), false);
});
test('failed return holds cursor; retry resumes after successfully sent chunks', async () => {
  const s = setup([event({ content: '中'.repeat(2200) })]);
  let attempts = 0;
  s.wecom.send = async (_chat, content) => { attempts++; if (attempts === 2) throw new Error('timeout'); s.calls.push(content); };
  await assert.rejects(s.bridge.poll()); await s.bridge.poll(); await s.bridge.poll();
  assert.equal(s.calls.length, 2);
  assert.deepEqual(s.cursors, [undefined, undefined, 42]);
  assert.equal(s.calls.map(x => x.slice('[Sol] '.length)).join(''), '中'.repeat(2200));
});
