import type { RaftEvent } from '@botiverse/raft-sdk';
import type { Config } from './config.js';
import type { RaftPort } from './raft.js';
import { cleanText, splitText, type TextFrame, type WecomPort } from './wecom.js';
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
  private queue: Promise<void> = Promise.resolve();
  private since?: number;
  readonly startedAt = Date.now();
  constructor(readonly cfg: Config, readonly raft: RaftPort, readonly wecom: WecomPort,
    readonly delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))) {}

  accept(frame: TextFrame): Promise<void> {
    const m = frame.body;
    if (!m || m.msgtype !== 'text' || m.chattype !== 'group' || m.chatid !== this.cfg.chatId || m.aibotid !== this.cfg.botId) return Promise.resolve();
    if (!m.msgid || !m.from?.userid || typeof m.text?.content !== 'string') return Promise.resolve();
    const key = `${m.chatid}:${m.msgid}`;
    if (this.inbound.has(key)) return Promise.resolve();
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const content = cleanText(m.text.content, this.cfg.botId, this.cfg.botName);
    if (!content) return this.wecom.acknowledge(frame, '请在 @机器人 后输入任务内容。');
    if (this.inFlight.size >= 100) return this.wecom.acknowledge(frame, '当前队列已满，请稍后重试。');
    log('wecom_received', { messageId: m.msgid, chatId: m.chatid, senderId: m.from.userid });
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
        log('raft_posted', { sourceMessageId: m.msgid, raftMessageId: raftId, chatId: m.chatid, senderId: m.from.userid });
      }
      // Reply once to the original callback, only after Raft confirms the result.
      // A notification failure must never resend an already accepted Raft task.
      await this.wecom.acknowledge(frame, raftId ? `已交给 ${this.cfg.targetAgent}。`
        : '暂时无法确认投递结果，请在 Raft 频道查看是否收到任务，避免重复提交。')
        .catch(error => log('wecom_notice_failed', { messageId: m.msgid, kind: errorKind(error) }));
    }).finally(() => { this.inFlight.delete(key); });
    this.inFlight.set(key, work);
    this.queue = work.catch(error => log('inbound_failed', { kind: errorKind(error) }));
    return work;
  }

  async poll(): Promise<boolean> {
    const batch = await this.raft.receive(this.since);
    for (const event of batch.events) {
      if (!belongsToChannel(event, this.cfg.channel) || event.senderType !== 'agent'
        || event.senderName === this.cfg.expectedAgent.slice(1) || !event.content?.trim()) continue;
      // No backlog replay in this MVP. `since: "latest"` does NOT skip queued events.
      if (!event.messageId || !event.timestamp || Date.parse(event.timestamp) < this.startedAt || !Number.isFinite(Date.parse(event.timestamp))) continue;
      const prefix = `[${event.senderName || 'Agent'}] `;
      const parts = splitText(event.content, 3500 - Buffer.byteLength(prefix));
      for (let i = 0; i < parts.length; i++) {
        const key = `${event.messageId}:${i}`;
        if (this.sentParts.has(key)) continue;
        await this.wecom.send(this.cfg.chatId, prefix + parts[i]);
        this.sentParts.add(key);
        log('wecom_forwarded', { raftMessageId: event.messageId, part: i + 1, parts: parts.length, chatId: this.cfg.chatId });
      }
    }
    // Commit only after every selected message has a successful WeCom receipt.
    if (batch.lastSeenSeq !== null) this.since = batch.lastSeenSeq;
    return batch.hasMore;
  }
  async drain() { await this.queue; }
}
