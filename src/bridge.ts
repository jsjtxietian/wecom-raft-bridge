import type { RaftEvent } from '@botiverse/raft-sdk';
import type { Config } from './config.js';
import type { RaftPort } from './raft.js';
import { PrivateSessions } from './private-sessions.js';
import { messageContent, splitText, conversationOf, type Conversation, type MessageFrame, type WecomPort } from './wecom.js';
import { ImageTransferError, MAX_MESSAGE_IMAGE_BYTES } from './images.js';
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
  private preparedImages = new Map<string, { root?: string; ids: string[]; bytes: number; sendAttempted: boolean }>();
  private pendingRoutes = new Map<string, Conversation>();
  private routes = new Map<string, Conversation>();
  private queue: Promise<void> = Promise.resolve();
  private since?: number;
  readonly startedAt = Date.now();
  constructor(readonly cfg: Config, readonly raft: RaftPort, readonly wecom: WecomPort,
    readonly delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
    readonly privateSessions = new PrivateSessions()) {
    for (const session of privateSessions.routes()) {
      if (cfg.allowPrivate) this.pendingRoutes.set(session.rootMessageId, { type: 'single', id: session.userId });
    }
  }

  accept(frame: MessageFrame): Promise<void> {
    const m = frame.body;
    if (!m || !['text', 'image', 'mixed'].includes(m.msgtype) || m.aibotid !== this.cfg.botId) return Promise.resolve();
    if (!m.msgid || !m.from?.userid) return Promise.resolve();
    const conversation = conversationOf(frame);
    if (!conversation || !this.enabled(conversation)) return Promise.resolve();
    const key = `${conversation.type}:${conversation.id}:${m.msgid}`;
    if (this.inbound.has(key)) return Promise.resolve();
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    let parsed: ReturnType<typeof messageContent>;
    try { parsed = messageContent(frame, this.cfg.botId, this.cfg.botName); }
    catch (error) { return this.notice(frame, error instanceof ImageTransferError ? error.message : '消息无法读取，请重新发送。'); }
    if (!parsed) return Promise.resolve();
    const { content, task, images } = parsed;
    if (!content) return this.wecom.acknowledge(frame, '请输入任务内容。');
    if (this.inFlight.size + this.pendingRoutes.size >= 100) return this.wecom.acknowledge(frame, '当前队列已满，请稍后重试。');
    log('wecom_received', { messageId: m.msgid, chatType: conversation.type, chatId: conversation.id,
      senderId: m.from.userid, hasQuote: Boolean(m.quote), imageCount: images.length });
    const work = this.queue.then(async () => {
      const sourceId = `${this.cfg.botId}:${key}`;
      // Commands are exact, standalone messages; quotes and prose remain ordinary tasks.
      if (m.msgtype === 'text' && !m.quote && !images.length && (content.toLowerCase() === '/new' || content === '新话题')) {
        if (conversation.type === 'group') {
          this.inbound.add(key);
          await this.notice(frame, '群聊每条提问都会新建话题，直接 @机器人 发送任务即可。');
          return;
        }
        if (this.privateSessions.hasReset(sourceId)) { this.inbound.add(key); return; }
        try { await this.privateSessions.reset(conversation.id, sourceId); }
        catch (error) {
          log('private_session_reset_failed', { messageId: m.msgid, kind: errorKind(error) });
          await this.notice(frame, '新话题未能保存，请稍后重试；原会话保持不变。');
          return;
        }
        this.inbound.add(key);
        log('private_session_reset', { messageId: m.msgid, senderId: m.from.userid });
        await this.notice(frame, '已切换新话题，请发送新的任务。');
        return;
      }
      // Look up inside the queue so simultaneous first messages cannot create two sessions.
      const session = conversation.type === 'single' ? this.privateSessions.get(conversation.id) : undefined;
      if (conversation.type === 'single') {
        if (this.privateSessions.hasFirstSource(sourceId)) { this.inbound.add(key); return; }
        try {
          await this.privateSessions.flush();
          if (session) {
            this.pendingRoutes.set(session.rootMessageId, conversation);
            await this.connectRoute(session.rootMessageId, conversation);
          }
        } catch (error) {
          log('private_session_unavailable', { messageId: m.msgid, kind: errorKind(error) });
          await this.notice(frame, '暂时无法恢复原有会话，请稍后重试。');
          return;
        }
      }
      let attachmentIds: string[] = [];
      if (images.length) {
        try {
          let prepared = this.preparedImages.get(key);
          if (!prepared) {
            prepared = { root: session?.rootMessageId, ids: [], bytes: 0, sendAttempted: false };
            this.preparedImages.set(key, prepared);
            if (this.preparedImages.size > 100) this.preparedImages.delete(this.preparedImages.keys().next().value!);
          }
          if (prepared.root !== session?.rootMessageId) throw new ImageTransferError('这条图片所属的话题已切换，请重新发送图片。');
          for (let i = prepared.ids.length; i < images.length; i++) {
            const image = await this.wecom.downloadImage(images[i]!, i);
            if (prepared.bytes + image.bytes.length > MAX_MESSAGE_IMAGE_BYTES) {
              throw new ImageTransferError('一条消息的图片总大小不能超过 20 MiB，请分开发送。');
            }
            const id = await this.raft.uploadImage(image, prepared.root);
            prepared.ids.push(id); prepared.bytes += image.bytes.length;
            log('raft_image_uploaded', { messageId: m.msgid, attachmentId: id, imageNumber: i + 1, bytes: image.bytes.length });
          }
          attachmentIds = prepared.ids;
        } catch (error) {
          log('image_transfer_failed', { messageId: m.msgid, kind: errorKind(error) });
          await this.notice(frame, this.preparedImages.get(key)?.sendAttempted
            ? '这条图片任务此前投递结果尚未确认，请先在 Raft 查看，避免重复提交。'
            : (error instanceof ImageTransferError ? error.message : '图片上传到 Raft 失败，请稍后重试。') + ' 本条任务尚未提交。');
          return;
        }
      }
      let raftId: string | undefined;
      const body = `${this.cfg.targetAgent}\n\n${task}`;
      const prepared = this.preparedImages.get(key);
      if (prepared) prepared.sendAttempted = true;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try { raftId = await this.raft.send(body, sourceId, session?.rootMessageId, attachmentIds); break; }
        catch (error) {
          log('raft_send_failed', { messageId: m.msgid, attempt, kind: errorKind(error) });
          if (attempt < 3) await this.delay(attempt * 1000);
        }
      }
      if (raftId) {
        this.inbound.add(key);
        this.preparedImages.delete(key);
        const rootMessageId = session?.rootMessageId ?? raftId;
        this.pendingRoutes.set(rootMessageId, conversation);
        log('raft_posted', { sourceMessageId: m.msgid, raftMessageId: raftId, chatType: conversation.type,
          raftRootMessageId: rootMessageId, chatId: conversation.id, senderId: m.from.userid });
        if (conversation.type === 'single' && !session) {
          this.privateSessions.remember({ userId: conversation.id, rootMessageId, firstSourceId: sourceId });
          try { await this.privateSessions.flush(); }
          catch (error) {
            log('private_session_save_failed', { raftMessageId: raftId, kind: errorKind(error) });
            await this.notice(frame, '任务已提交，但会话记录保存异常，请联系维护者检查。');
            return;
          }
        }
        // Register immediately, then let polling retry a failed follow/resolve separately.
        if (!session) await this.connectRoute(rootMessageId, conversation).catch(() => {});
        else this.pendingRoutes.delete(rootMessageId);
      }
      // Successful submission stays silent; agent replies arrive through poll().
      if (!raftId) await this.notice(frame, '暂时无法确认投递结果，请在 Raft 频道查看是否收到任务，避免重复提交。');
    }).finally(() => { this.inFlight.delete(key); });
    this.inFlight.set(key, work);
    this.queue = work.catch(error => log('inbound_failed', { kind: errorKind(error) }));
    return work;
  }

  private enabled(conversation: Conversation) {
    return conversation.type === 'single' ? this.cfg.allowPrivate : this.cfg.allowGroup;
  }

  private notice(frame: MessageFrame, text: string) {
    return this.wecom.acknowledge(frame, text)
      .catch(error => log('wecom_notice_failed', { messageId: frame.body?.msgid, kind: errorKind(error) }));
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
    await this.privateSessions.flush();
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
