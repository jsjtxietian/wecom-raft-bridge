import type { RaftEvent } from '@botiverse/raft-sdk';
import type { Config } from './config.js';
import type { RaftPort } from './raft.js';
import { cleanText, splitText, conversationOf, type Conversation, type TextFrame, type WecomPort } from './wecom.js';
import { errorKind, log } from './log.js';

export function belongsToChannel(event: RaftEvent, channel: string): boolean {
  const name = channel.replace(/^#/, '');
  return (event.channelType === 'channel' && event.channelName === name)
    || (event.channelType === 'thread' && event.parentChannelType === 'channel' && event.parentChannelName === name);
}

class RecentIds {
  private ids = new Set<string>();
  has(id: string) { return this.ids.has(id); }
  add(id: string) {
    this.ids.add(id);
    if (this.ids.size > 10_000) this.ids.delete(this.ids.values().next().value!);
  }
}

export class Bridge {
  private inbound = new RecentIds();
  private inFlight = new Map<string, Promise<void>>();
  private sentParts = new RecentIds();
  private pendingRoutes = new Map<string, Conversation>();
  private routes = new Map<string, Conversation>();
  private queue: Promise<void> = Promise.resolve();
  private since?: number;
  readonly startedAt = Date.now();
  constructor(readonly cfg: Config, readonly raft: RaftPort, readonly wecom: WecomPort,
    readonly delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))) {}

  accept(frame: TextFrame): Promise<void> {
    const m = frame.body;
    if (!m || m.msgtype !== 'text' || m.aibotid !== this.cfg.botId) return Promise.resolve();
    if (!m.msgid || !m.from?.userid || typeof m.text?.content !== 'string') return Promise.resolve();
    const conversation = conversationOf(frame);
    if (!conversation || !this.enabled(conversation)) return Promise.resolve();
    const key = `${conversation.type}:${conversation.id}:${m.msgid}`;
    if (this.inbound.has(key)) return Promise.resolve();
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const content = cleanText(m.text.content, this.cfg.botId, this.cfg.botName);
    if (!content) return this.wecom.acknowledge(frame, '请输入任务内容。');
    if (this.inFlight.size + this.pendingRoutes.size >= 100) return this.wecom.acknowledge(frame, '当前队列已满，请稍后重试。');
    log('wecom_received', { messageId: m.msgid, chatType: conversation.type, chatId: conversation.id, senderId: m.from.userid });
    const work = this.queue.then(async () => {
      let raftId: string | undefined;
      const body = `${this.cfg.targetAgent}\n\n${content}`;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try { raftId = await this.raft.send(body, `${this.cfg.botId}:${key}`); break; }
        catch (error) {
          log('raft_send_failed', { messageId: m.msgid, attempt, kind: errorKind(error) });
          if (attempt < 3) await this.delay(attempt * 1000);
        }
      }
      if (raftId) {
        this.inbound.add(key);
        this.pendingRoutes.set(raftId, conversation);
        log('raft_posted', { sourceMessageId: m.msgid, raftMessageId: raftId, chatType: conversation.type,
          chatId: conversation.id, senderId: m.from.userid });
        // Register immediately, then let polling retry a failed follow/resolve separately.
        await this.connectRoute(raftId, conversation).catch(() => {});
      }
      // Successful submission stays silent; agent replies arrive through poll().
      if (!raftId) await this.wecom.acknowledge(frame,
        '暂时无法确认投递结果，请在 Raft 频道查看是否收到任务，避免重复提交。')
        .catch(error => log('wecom_notice_failed', { messageId: m.msgid, kind: errorKind(error) }));
    }).finally(() => { this.inFlight.delete(key); });
    this.inFlight.set(key, work);
    this.queue = work.catch(error => log('inbound_failed', { kind: errorKind(error) }));
    return work;
  }

  private enabled(conversation: Conversation) {
    return conversation.type === 'single' ? this.cfg.allowPrivate : this.cfg.allowGroup;
  }

  poll(): Promise<boolean> {
    // Share the inbound queue: even an instant reply cannot overtake its route registration.
    const work = this.queue.then(() => this.pollReplies());
    this.queue = work.then(() => {}, () => {});
    return work;
  }

  private async connectRoute(messageId: string, conversation: Conversation) {
    try {
      const threadId = await this.raft.ensureThread(messageId);
      const existing = this.routes.get(threadId);
      if (existing && (existing.type !== conversation.type || existing.id !== conversation.id)) {
        throw new Error('Raft thread route conflict');
      }
      this.routes.set(threadId, conversation);
      if (this.routes.size > 10_000) this.routes.delete(this.routes.keys().next().value!);
      this.pendingRoutes.delete(messageId);
      log('raft_route_ready', { raftMessageId: messageId, threadId, chatType: conversation.type, chatId: conversation.id });
    } catch (error) {
      log('raft_route_pending', { raftMessageId: messageId, kind: errorKind(error) });
      throw error;
    }
  }

  private async pollReplies(): Promise<boolean> {
    // Resolve/follow failures retry here without reposting the accepted task or consuming replies.
    for (const [messageId, conversation] of this.pendingRoutes) {
      await this.connectRoute(messageId, conversation);
    }
    const batch = await this.raft.receive(this.since);
    for (const event of batch.events) {
      if (!belongsToChannel(event, this.cfg.channel) || event.senderType !== 'agent'
        || event.senderName === this.cfg.expectedAgent.slice(1) || !event.content?.trim()) continue;
      // No backlog replay in this MVP. `since: "latest"` does NOT skip queued events.
      if (!event.messageId || !event.timestamp || Date.parse(event.timestamp) < this.startedAt || !Number.isFinite(Date.parse(event.timestamp))) continue;
      // A channel-level reply has no source conversation. Never broadcast or guess the last sender.
      const conversation = event.channelType === 'thread' && event.channelId ? this.routes.get(event.channelId) : undefined;
      if (!conversation) {
        log('raft_reply_unrouted', { raftMessageId: event.messageId, channelId: event.channelId });
        continue;
      }
      if (!this.enabled(conversation)) continue;
      const prefix = `[${event.senderName || 'Agent'}] `;
      const parts = splitText(event.content, 3500 - Buffer.byteLength(prefix));
      for (let i = 0; i < parts.length; i++) {
        const key = `${event.messageId}:${i}`;
        if (this.sentParts.has(key)) continue;
        await this.wecom.send(conversation.id, prefix + parts[i]);
        this.sentParts.add(key);
        log('wecom_forwarded', { raftMessageId: event.messageId, part: i + 1, parts: parts.length,
          chatType: conversation.type, chatId: conversation.id });
      }
    }
    // Commit only after every selected message has a successful WeCom receipt.
    if (batch.lastSeenSeq !== null) this.since = batch.lastSeenSeq;
    return batch.hasMore;
  }
  async drain() { await this.queue; }
}
