import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RaftEvent, RaftEventsReceiveData } from '@botiverse/raft-sdk';
import { Bridge, belongsToChannel } from '../src/bridge.js';
import type { Config } from '../src/config.js';
import { cleanText, withQuote, splitText, type TextFrame, type MessageFrame, type WecomPort } from '../src/wecom.js';
import { ImageTransferError } from '../src/images.js';
import type { RaftPort } from '../src/raft.js';
import { PrivateSessions } from '../src/private-sessions.js';

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
function setup(events: RaftEvent[] = [], config: Partial<Config> = {}, sessions = new PrivateSessions()) {
  const calls: string[] = [], cursors: (number | undefined)[] = [];
  const posts: { body: string; key: string; rootMessageId?: string; attachmentIds: string[] }[] = [];
  const uploads: { filename: string; rootMessageId?: string }[] = [];
  const sent: { chatId: string; text: string }[] = [];
  const raft: RaftPort = {
    async send(body, key, rootMessageId, attachmentIds = []) { calls.push('raft'); posts.push({ body, key, rootMessageId, attachmentIds: [...attachmentIds] }); return `raft-${posts.length}`; },
    async uploadImage(image, rootMessageId) { uploads.push({ filename: image.filename, rootMessageId }); return `attachment-${uploads.length}`; },
    async ensureThread(messageId) { return `thread-${messageId}`; },
    async receive(cursor) { cursors.push(cursor); return { events, lastSeenSeq: 42, ackMode: 'cursor', hasMore: false,
      lastSeenMessageId: null, replyTarget: null } satisfies RaftEventsReceiveData; },
  };
  const wecom: WecomPort = { async acknowledge(_frame, text) { calls.push(text); },
    async downloadImage(_image, index) { return { filename: `image-${index + 1}.png`, bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' }; },
    async send(chatId, text) { calls.push(text); sent.push({ chatId, text }); } };
  return { calls, posts, uploads, cursors, sent, raft, wecom, sessions,
    bridge: new Bridge({ ...cfg, ...config }, raft, wecom, async () => {}, sessions) };
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
test('quoted questions in private and group chats carry context and route replies to the source', async () => {
  for (const type of ['single', 'group'] as const) {
    const s = setup([event()]);
    const f = frame('quoted', { chattype: type, chatid: type === 'group' ? 'quote-group' : undefined,
      text: { content: '@桥接机器人 为什么？请问 @Helper' },
      quote: { msgtype: 'text', text: { content: '@Sol 不支持导出\r\n邮箱：user@example.com\r\n\r\n第二段' } } });
    await Promise.all([s.bridge.accept(f), s.bridge.accept(f)]);
    assert.equal(s.posts.length, 1);
    assert.equal(s.posts[0]!.body,
      '@Sol\n\n引用内容：\n> ＠Sol 不支持导出\n> 邮箱：user@example.com\n> \n> 第二段\n\n本次提问：\n为什么？请问 @Helper');
    assert.deepEqual(s.calls, ['raft']);
    await s.bridge.poll();
    assert.deepEqual(s.sent, [{ chatId: type === 'group' ? 'quote-group' : 'person-1', text: '[Sol] 任务完成' }]);
  }
});

test('mixed quotes include available text but never treat media URLs as readable content', () => {
  const text = withQuote('说明一下', { msgtype: 'mixed', mixed: { msg_item: [
    { msgtype: 'text', text: { content: '第一段' } },
    { msgtype: 'image', image: { url: 'https://example.test/private-media' } },
    { msgtype: 'text', text: { content: '第二段' } },
  ] } });
  assert.equal(text, '引用内容：\n> 第一段\n> （引用中的非文字内容未读取）\n> 第二段\n\n本次提问：\n说明一下');
  assert.ok(!text.includes('private-media'));
});

test('empty or unsupported quotes preserve the question; a quote alone does not become a task', async () => {
  for (const quote of [{ msgtype: 'text', text: { content: '  ' } },
    { msgtype: 'file', file: { url: 'https://example.test/private-file' } },
    { msgtype: 'text', text: { content: 123 } }]) {
    const f = frame('empty-quote'); f.body!.quote = quote as NonNullable<TextFrame['body']>['quote'];
    const s = setup(); await s.bridge.accept(f);
    assert.ok(s.posts[0]!.body.endsWith('本次提问：\n请检查 a@b.com 和 @另一个人'));
    assert.ok(!s.posts[0]!.body.includes('private-file'));
  }
  const s = setup();
  await s.bridge.accept(frame('no-question', { text: { content: '@桥接机器人' },
    quote: { msgtype: 'text', text: { content: '旧任务' } } }));
  assert.equal(s.posts.length, 0);
  assert.deepEqual(s.calls, ['请输入任务内容。']);
});

test('wrong bot, missing group id and unsupported messages never enter Raft', async () => {
  const s = setup();
  for (const patch of [{ chatid: undefined }, { chattype: 'unknown' }, { aibotid: 'other' },
    { from: { userid: '' } }, { msgtype: 'video' }]) {
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

const privateFrame = (id: string, userId = 'user-A') => frame(id, {
  chattype: 'single', chatid: undefined, from: { userid: userId },
});

test('private follow-ups reuse their own root; group messages remain independent', async () => {
  const s = setup([event(), event({ messageId: 'reply-B', channelId: 'thread-raft-2' })]);
  await s.bridge.accept(privateFrame('A1'));
  await s.bridge.accept(privateFrame('B1', 'user-B'));
  await s.bridge.accept(privateFrame('A2'));
  await s.bridge.accept(frame('group1'));
  await s.bridge.accept(frame('group2'));
  await s.bridge.accept(privateFrame('B2', 'user-B'));
  const quoted = privateFrame('A3'); quoted.body!.quote = { msgtype: 'text', text: { content: '补充背景' } };
  await s.bridge.accept(quoted);
  assert.deepEqual(s.posts.map(p => p.rootMessageId), [undefined, undefined, 'raft-1', undefined, undefined, 'raft-2', 'raft-1']);
  assert.ok(s.posts[6]!.body.includes('> 补充背景'));
  assert.ok(s.posts.every(p => p.body.startsWith('@Sol\n\n')));
  await s.bridge.poll();
  assert.deepEqual(s.sent.map(p => p.chatId), ['user-A', 'user-B']);
});

test('simultaneous first private messages create just one root and keep per-message deduplication', async () => {
  const s = setup();
  await Promise.all([s.bridge.accept(privateFrame('first')), s.bridge.accept(privateFrame('second')),
    s.bridge.accept(privateFrame('first'))]);
  assert.deepEqual(s.posts.map(p => p.rootMessageId), [undefined, 'raft-1']);
  assert.equal(s.sessions.all().length, 1);
});

test('restored sessions route new replies and follow-ups; the first callback is not reposted', async () => {
  const sessions = new PrivateSessions();
  sessions.remember({ userId: 'user-A', rootMessageId: 'old-root', firstSourceId: 'bot-id:single:user-A:first' });
  const s = setup([event({ channelId: 'thread-old-root' })], {}, sessions);
  await s.bridge.poll();
  assert.deepEqual(s.sent, [{ chatId: 'user-A', text: '[Sol] 任务完成' }]);
  await s.bridge.accept(privateFrame('first'));
  assert.equal(s.posts.length, 0);
  await s.bridge.accept(privateFrame('follow-up'));
  assert.equal(s.posts[0]!.rootMessageId, 'old-root');
});

test('an unavailable private thread never silently switches to a new root', async () => {
  const s = setup();
  await s.bridge.accept(privateFrame('first'));
  const ensureThread = s.raft.ensureThread;
  s.raft.ensureThread = async () => { throw new Error('missing thread'); };
  await s.bridge.accept(privateFrame('follow-up'));
  assert.equal(s.posts.length, 1);
  assert.ok(s.calls.includes('暂时无法恢复原有会话，请稍后重试。'));
  s.raft.ensureThread = ensureThread;
  await s.bridge.accept(privateFrame('follow-up'));
  assert.equal(s.posts[1]!.rootMessageId, 'raft-1');
});

test('private follow-up send retries keep the same destination and idempotency key', async () => {
  const s = setup();
  await s.bridge.accept(privateFrame('first'));
  const attempts: { key: string; root?: string }[] = [];
  s.raft.send = async (_body, key, root) => { attempts.push({ key, root }); throw new Error('timeout'); };
  await s.bridge.accept(privateFrame('follow-up'));
  assert.equal(attempts.length, 3);
  assert.equal(new Set(attempts.map(a => a.key)).size, 1);
  assert.ok(attempts.every(a => a.root === 'raft-1'));
  assert.equal(s.sessions.get('user-A')!.rootMessageId, 'raft-1');
});

test('failed session persistence blocks continuation until saved, without reposting the accepted root', async () => {
  const s = setup([event()]);
  const flush = s.sessions.flush.bind(s.sessions);
  s.sessions.flush = async () => { if (s.sessions.all().length) throw new Error('disk full'); };
  await s.bridge.accept(privateFrame('first'));
  await s.bridge.accept(privateFrame('second'));
  await assert.rejects(s.bridge.poll());
  assert.equal(s.posts.length, 1);
  assert.equal(s.cursors.length, 0);
  s.sessions.flush = flush;
  await s.bridge.poll();
  await s.bridge.accept(privateFrame('second'));
  assert.equal(s.posts[1]!.rootMessageId, 'raft-1');
  assert.deepEqual(s.sent, [{ chatId: 'user-A', text: '[Sol] 任务完成' }]);
});

test('/new switches only the sender; queued follow-ups share a new root and old replies still return', async () => {
  const s = setup([event(), event({ messageId: 'new-reply', channelId: 'thread-raft-3' })]);
  await s.bridge.accept(privateFrame('A1'));
  await s.bridge.accept(privateFrame('B1', 'user-B'));
  const reset = privateFrame('reset'); reset.body!.text.content = ' /new ';
  await Promise.all([s.bridge.accept(reset), s.bridge.accept(privateFrame('A2')),
    s.bridge.accept(privateFrame('A3')), s.bridge.accept(reset)]);
  await s.bridge.accept(privateFrame('B2', 'user-B'));
  assert.deepEqual(s.posts.map(p => p.rootMessageId), [undefined, undefined, undefined, 'raft-3', 'raft-2']);
  assert.equal(s.calls.filter(text => text === '已切换新话题，请发送新的任务。').length, 1);
  assert.equal(s.sessions.get('user-A')!.rootMessageId, 'raft-3');
  await s.bridge.poll();
  assert.deepEqual(s.sent.map(p => p.chatId), ['user-A', 'user-A']);
});

test('new-topic commands are standalone, private-only, and never sent as group tasks', async () => {
  const s = setup();
  for (const command of ['/new', '新话题']) {
    const f = frame(command); f.body!.text.content = `@桥接机器人 ${command}`;
    await s.bridge.accept(f);
  }
  assert.equal(s.posts.length, 0);
  assert.ok(s.calls.every(text => text.includes('群聊每条提问')));
  const first = privateFrame('start-new'); first.body!.text.content = '新话题';
  await s.bridge.accept(first);
  assert.equal(s.sessions.all().length, 0);
  for (const [index, content] of ['解释 /new 的意思', '/new 请帮忙', '/new'].entries()) {
    const f = privateFrame(`text-${index}`); f.body!.text.content = content;
    if (index === 2) f.body!.quote = { msgtype: 'text', text: { content: '引用的问题' } };
    await s.bridge.accept(f);
  }
  assert.equal(s.posts.length, 3);
  assert.deepEqual(s.posts.map(p => p.rootMessageId), [undefined, 'raft-1', 'raft-1']);
});

test('a failed reset keeps the old conversation and reports failure before any confirmation', async () => {
  const s = setup();
  await s.bridge.accept(privateFrame('first'));
  const reset = privateFrame('reset'); reset.body!.text.content = '/new';
  s.sessions.reset = async () => { throw new Error('disk full'); };
  await s.bridge.accept(reset);
  await s.bridge.accept(privateFrame('next'));
  assert.equal(s.posts[1]!.rootMessageId, 'raft-1');
  assert.ok(s.calls.includes('新话题未能保存，请稍后重试；原会话保持不变。'));
  assert.ok(!s.calls.includes('已切换新话题，请发送新的任务。'));
});

test('replayed reset and retired first messages cannot reset or resurrect a topic after reload', async () => {
  const sessions = new PrivateSessions();
  sessions.remember({ userId: 'user-A', rootMessageId: 'old-root', firstSourceId: 'bot-id:single:user-A:first' });
  await sessions.reset('user-A', 'bot-id:single:user-A:reset');
  sessions.remember({ userId: 'user-A', rootMessageId: 'new-root', firstSourceId: 'bot-id:single:user-A:second' });
  const s = setup([event({ channelId: 'thread-old-root' })], {}, sessions);
  const reset = privateFrame('reset'); reset.body!.text.content = '/new';
  await s.bridge.accept(reset);
  await s.bridge.accept(privateFrame('first'));
  await s.bridge.accept(privateFrame('third'));
  assert.equal(s.posts.length, 1);
  assert.equal(s.posts[0]!.rootMessageId, 'new-root');
  await s.bridge.poll();
  assert.equal(s.sent[0]!.chatId, 'user-A');
});

const imageRef = { url: 'https://wework.qpic.cn/fake-private-image', aeskey: 'fake-per-image-key' };
function imageFrame(id: string): MessageFrame {
  return { ...privateFrame(id), body: { ...privateFrame(id).body!, msgtype: 'image', image: imageRef } } as MessageFrame;
}

test('private image creates or reuses its own thread and returns the agent reply silently', async () => {
  const s = setup([event()]);
  await Promise.all([s.bridge.accept(imageFrame('image1')), s.bridge.accept(imageFrame('image1'))]);
  await s.bridge.accept(imageFrame('image2'));
  assert.deepEqual(s.posts.map(p => p.attachmentIds), [['attachment-1'], ['attachment-2']]);
  assert.deepEqual(s.uploads.map(p => p.rootMessageId), [undefined, 'raft-1']);
  assert.equal(s.posts[1]!.rootMessageId, 'raft-1');
  assert.ok(s.posts.every(p => p.body === '@Sol\n\n请查看图片，并结合当前对话回答。'));
  assert.ok(s.posts.every(p => !p.body.includes(imageRef.url) && !p.body.includes(imageRef.aeskey)));
  assert.deepEqual(s.calls, ['raft', 'raft']);
  await s.bridge.poll();
  assert.equal(s.sent[0]!.chatId, 'user-A');
});

test('mixed and quoted images preserve order with text and remain isolated across private users and groups', async () => {
  const s = setup();
  const mixed = frame('mixed', { text: undefined }) as MessageFrame;
  Object.assign(mixed.body!, { msgtype: 'mixed', mixed: { msg_item: [
    { msgtype: 'text', text: { content: '@桥接机器人 对比这两张图' } },
    { msgtype: 'image', image: imageRef }, { msgtype: 'text', text: { content: '和' } },
    { msgtype: 'image', image: imageRef },
  ] }, quote: { msgtype: 'mixed', mixed: { msg_item: [
    { msgtype: 'text', text: { content: '@Sol 之前的说明' } }, { msgtype: 'image', image: imageRef },
  ] } } });
  await s.bridge.accept(mixed);
  const quoted = privateFrame('quoted-image', 'user-B');
  quoted.body!.quote = { msgtype: 'image', image: imageRef };
  await s.bridge.accept(quoted);
  assert.deepEqual(s.posts[0]!.attachmentIds, ['attachment-1', 'attachment-2', 'attachment-3']);
  assert.equal(s.posts[0]!.body, '@Sol\n\n引用内容：\n> ＠Sol 之前的说明\n\n本次提问：\n对比这两张图\n和');
  assert.deepEqual(s.posts[1]!.attachmentIds, ['attachment-4']);
  assert.equal(s.posts[1]!.body, '@Sol\n\n请检查 a@b.com 和 @另一个人');
  assert.equal(s.sessions.get('user-B')!.rootMessageId, 'raft-2');
});

test('image errors never submit incomplete questions; retries reuse confirmed uploads and send keys', async () => {
  const s = setup();
  const download = s.wecom.downloadImage;
  s.wecom.downloadImage = async () => { throw new ImageTransferError('图片已过期。'); };
  await s.bridge.accept(imageFrame('image'));
  assert.equal(s.posts.length, 0);
  assert.ok(s.calls.includes('图片已过期。 本条任务尚未提交。'));
  s.wecom.downloadImage = download;
  const send = s.raft.send, attempts: { key: string; attachments: string[] }[] = [];
  s.raft.send = async (_body, key, _root, attachments = []) => {
    attempts.push({ key, attachments: [...attachments] }); throw new Error('timeout');
  };
  await s.bridge.accept(imageFrame('image'));
  assert.equal(s.uploads.length, 1);
  s.raft.send = send;
  await s.bridge.accept(imageFrame('image'));
  assert.equal(s.uploads.length, 1);
  assert.equal(attempts.length, 3);
  assert.ok(attempts.every(a => a.key === s.posts[0]!.key && a.attachments[0] === s.posts[0]!.attachmentIds[0]));
});

test('image limits and disabled private messages do not download or upload media', async () => {
  const off = setup([], { allowPrivate: false });
  await off.bridge.accept(imageFrame('off'));
  assert.equal(off.uploads.length, 0);
  const s = setup();
  const many = imageFrame('many');
  Object.assign(many.body!, { msgtype: 'mixed', mixed: { msg_item: Array.from({ length: 5 }, () => ({ msgtype: 'image', image: imageRef })) } });
  await s.bridge.accept(many);
  assert.equal(s.uploads.length, 0); assert.equal(s.posts.length, 0);
  assert.ok(s.calls[0]!.includes('最多支持 4 张'));
});
