import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RaftEvent, RaftEventsReceiveData } from '@botiverse/raft-sdk';
import { Bridge, belongsToChannel } from '../src/bridge.js';
import type { Config } from '../src/config.js';
import { cleanText, splitText, type TextFrame, type WecomPort } from '../src/wecom.js';
import type { RaftPort } from '../src/raft.js';

const cfg: Config = { botId: 'bot-id', secret: 'test-secret', botName: '桥接机器人', allowPrivate: true, allowGroup: true,
  serverUrl: 'https://example.test', credential: 'sk_agent_test', channel: '#StoryLoom_Wecom',
  targetAgent: '@Sol', expectedAgent: '@WeCom', pollMs: 2000 };
const frame = (id = 'source-1', patch: Partial<NonNullable<TextFrame['body']>> = {}): TextFrame => ({ headers: { req_id: 'request-1' }, body: {
  msgid: id, aibotid: cfg.botId, chatid: 'group-1', chattype: 'group', from: { userid: 'person-1' },
  msgtype: 'text', text: { content: '@桥接机器人 请检查 a@b.com 和 @另一个人' },
  ...patch,
} } as TextFrame);
const event = (overrides: Partial<RaftEvent> = {}): RaftEvent => ({ type: 'message', messageId: 'reply-1',
  timestamp: new Date(Date.now() + 1000).toISOString(), senderType: 'agent', senderName: 'Sol',
  content: '任务完成', channelId: 'thread-raft-1', channelName: 'opaque-thread-name', channelType: 'thread',
  parentChannelName: 'StoryLoom_Wecom', parentChannelType: 'channel', attachments: [], ...overrides });
function setup(events: RaftEvent[] = [], config: Partial<Config> = {}) {
  const calls: string[] = [], cursors: (number | undefined)[] = [], posts: { body: string; key: string }[] = [];
  const sent: { chatId: string; text: string }[] = [];
  const raft: RaftPort = {
    async send(body, key) { calls.push('raft'); posts.push({ body, key }); return `raft-${posts.length}`; },
    async ensureThread(messageId) { return `thread-${messageId}`; },
    async receive(cursor) { cursors.push(cursor); return { events, lastSeenSeq: 42, ackMode: 'cursor', hasMore: false,
      lastSeenMessageId: null, replyTarget: null } satisfies RaftEventsReceiveData; },
  };
  const wecom: WecomPort = { async acknowledge(_frame, text) { calls.push(text); },
    async send(chatId, text) { calls.push(text); sent.push({ chatId, text }); } };
  return { calls, posts, cursors, sent, raft, wecom, bridge: new Bridge({ ...cfg, ...config }, raft, wecom, async () => {}) };
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
test('successful submission stays silent, preserves plain task and deduplicates callbacks', async () => {
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
  assert.deepEqual(s.calls, ['raft']);
  assert.equal(s.posts[0]!.body, '@Sol\n\n请检查 a@b.com 和 @另一个人');
  assert.equal(s.posts.length, 1);
});
test('wrong bot, missing group id and unsupported messages never enter Raft', async () => {
  const s = setup();
  for (const patch of [{ chatid: undefined }, { chattype: 'unknown' }, { aibotid: 'other' },
    { from: { userid: '' } }, { msgtype: 'image' }]) {
    const f = frame(); Object.assign(f.body!, patch); await s.bridge.accept(f);
  }
  assert.equal(s.calls.length, 0);
});
test('private and group switches work independently, including both disabled', async () => {
  for (const allowPrivate of [true, false]) for (const allowGroup of [true, false]) {
    const s = setup([], { allowPrivate, allowGroup });
    await s.bridge.accept(frame('private', { chattype: 'single', chatid: undefined }));
    await s.bridge.accept(frame('group', { chatid: 'any-group' }));
    assert.equal(s.posts.length, Number(allowPrivate) + Number(allowGroup));
    assert.ok(s.posts.every(p => p.key.includes(':single:') ? allowPrivate : allowGroup));
  }
});
test('two groups and two private users receive only their own interleaved thread replies', async () => {
  const replies = [event({ messageId: 'b', channelId: 'thread-raft-2', content: 'B' }),
    event({ messageId: 'd', channelId: 'thread-raft-4', content: 'D' }),
    event({ messageId: 'a', channelId: 'thread-raft-1', content: 'A' }),
    event({ messageId: 'c', channelId: 'thread-raft-3', content: 'C' })];
  const s = setup(replies);
  // Identical upstream message ids across conversations must not collide.
  await Promise.all([
    s.bridge.accept(frame('same', { chatid: 'group-A' })),
    s.bridge.accept(frame('same', { chatid: 'group-B' })),
    s.bridge.accept(frame('same', { chattype: 'single', chatid: undefined, from: { userid: 'user-A' } })),
    s.bridge.accept(frame('same', { chattype: 'single', chatid: 'ignored', from: { userid: 'user-B' } })),
  ]);
  await s.bridge.poll(); await s.bridge.poll();
  assert.deepEqual(s.sent, [
    { chatId: 'group-B', text: '[Sol] B' }, { chatId: 'user-B', text: '[Sol] D' },
    { chatId: 'group-A', text: '[Sol] A' }, { chatId: 'user-A', text: '[Sol] C' },
  ]);
  assert.equal(new Set(s.posts.map(p => p.key)).size, 4);
});
test('failure retries use the same key and never claim submission', async () => {
  const s = setup(), keys: string[] = [];
  s.raft.send = async (_body, key) => { keys.push(key); throw new Error('timeout'); };
  await s.bridge.accept(frame());
  assert.equal(keys.length, 3); assert.equal(new Set(keys).size, 1);
  assert.equal(s.calls.length, 1);
  assert.ok(s.calls.every(text => !text.startsWith('已交给')));
});
test('failed error notice does not block the next task', async () => {
  const s = setup(), originalSend = s.raft.send;
  s.raft.send = async () => { throw new Error('timeout'); };
  s.wecom.acknowledge = async () => { throw new Error('disconnect'); };
  await s.bridge.accept(frame());
  s.raft.send = originalSend;
  await s.bridge.accept(frame('source-2'));
  assert.equal(s.posts.length, 1);
  assert.deepEqual(s.calls, ['raft']);
});
test('only new agent replies in a mapped thread are returned; root and unknown threads stay local', async () => {
  const s = setup([event(), event({ messageId: 'collaboration', senderName: 'Collaborator' }),
    event({ senderName: 'WeCom' }), event({ senderType: 'human' }), event({ senderType: 'system' }),
    event({ parentChannelName: 'elsewhere' }), event({ timestamp: '2000-01-01T00:00:00Z' }), event({ timestamp: 'invalid' }),
    event({ channelType: 'channel', channelName: 'StoryLoom_Wecom' }),
    event({ channelId: 'unknown-thread' }), event({ channelId: undefined })]);
  await s.bridge.accept(frame()); s.calls.length = 0;
  await s.bridge.poll(); await s.bridge.poll();
  assert.deepEqual(s.calls, ['[Sol] 任务完成', '[Collaborator] 任务完成']);
  assert.deepEqual(s.cursors, [undefined, 42]);
  assert.equal(belongsToChannel(event({ channelType: 'dm' }), cfg.channel), false);
});
test('failed return holds cursor; retry resumes after successfully sent chunks', async () => {
  const s = setup([event({ content: '中'.repeat(2200) })]);
  await s.bridge.accept(frame()); s.calls.length = 0;
  let attempts = 0;
  s.wecom.send = async (_chat, content) => { attempts++; if (attempts === 2) throw new Error('timeout'); s.calls.push(content); };
  await assert.rejects(s.bridge.poll()); await s.bridge.poll(); await s.bridge.poll();
  assert.equal(s.calls.length, 2);
  assert.deepEqual(s.cursors, [undefined, undefined, 42]);
  assert.equal(s.calls.map(x => x.slice('[Sol] '.length)).join(''), '中'.repeat(2200));
});
test('polling cannot consume an instant reply before the source route is registered', async () => {
  const s = setup([event()]);
  let completeSend!: (id: string) => void;
  s.raft.send = () => new Promise<string>(resolve => { completeSend = resolve; });
  const accepting = s.bridge.accept(frame());
  const polling = s.bridge.poll();
  await Promise.resolve();
  assert.equal(s.cursors.length, 0);
  completeSend('raft-1');
  await Promise.all([accepting, polling]);
  assert.deepEqual(s.sent, [{ chatId: 'group-1', text: '[Sol] 任务完成' }]);
});
test('thread setup failure retries without reposting the task or consuming its reply', async () => {
  const s = setup([event()]), ensure = s.raft.ensureThread;
  s.raft.ensureThread = async () => { throw new Error('network'); };
  await s.bridge.accept(frame());
  await assert.rejects(s.bridge.poll());
  await s.bridge.accept(frame());
  assert.equal(s.posts.length, 1);
  assert.equal(s.cursors.length, 0);
  s.raft.ensureThread = ensure;
  await s.bridge.poll();
  assert.deepEqual(s.sent, [{ chatId: 'group-1', text: '[Sol] 任务完成' }]);
});
test('a fresh bridge never guesses a destination for previous or untracked tasks', async () => {
  const s = setup([event()]);
  await s.bridge.poll(); await s.bridge.poll();
  assert.deepEqual(s.sent, []);
  assert.deepEqual(s.cursors, [undefined, 42]);
});
