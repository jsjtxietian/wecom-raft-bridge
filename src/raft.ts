import { createRaftClient, type RaftClient, type RaftEventsReceiveData } from '@botiverse/raft-sdk';
import { createHash } from 'node:crypto';
import type { Config } from './config.js';
import { log, BridgeError } from './log.js';

export interface RaftPort {
  send(content: string, sourceId: string, rootMessageId?: string): Promise<string>;
  ensureThread(messageId: string): Promise<string>;
  receive(since?: number): Promise<RaftEventsReceiveData>;
}

export class RaftConnection implements RaftPort {
  readonly client: RaftClient;
  agentName = '';
  channelId = '';
  constructor(readonly cfg: Config) {
    this.client = createRaftClient({ serverUrl: cfg.serverUrl, credential: cfg.credential,
      fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(20_000) }),
    });
  }
  async check() {
    const context = await this.client.agent.context();
    if (!context.ok) throw new Error(`Raft 身份检查失败（HTTP ${context.status ?? 'network'}）`);
    this.agentName = context.data.agent.name;
    if (!context.data.agent.external || `@${this.agentName}` !== this.cfg.expectedAgent) throw new Error('Raft 凭据身份与 RAFT_EXPECTED_AGENT 不符');
    for (const capability of ['send', 'read', 'channels', 'mentions']) {
      if (!context.data.capabilities.includes(capability)) throw new Error(`Raft 凭据缺少 ${capability} 权限`);
    }
    const members = await this.client.routes.channels.members({ query: { channel: this.cfg.channel } });
    if (!members.ok) throw new Error(`无法读取 Raft 频道成员（HTTP ${members.status ?? 'network'}）`);
    if (!members.data.agents.some(a => `@${a.name}` === this.cfg.targetAgent)) throw new Error('频道内找不到 RAFT_TARGET_AGENT');
    const resolved = await this.client.routes.channels.resolve({ body: { target: this.cfg.channel } });
    if (!resolved.ok) throw new Error('桥接身份无法向指定频道发消息');
    this.channelId = resolved.data.channelId;
    log('raft_ready', { agent: this.agentName, channel: this.cfg.channel, targetAgent: this.cfg.targetAgent,
      members: members.data.agents.map(a => ({ name: a.name, status: a.status })) });
  }
  async send(content: string, sourceId: string, rootMessageId?: string): Promise<string> {
    const target = rootMessageId ? `${this.cfg.channel}:${rootMessageId.slice(0, 8)}` : this.cfg.channel;
    const result = await this.client.messages.send({ target, content,
      idempotencyKey: `wecom:${createHash('sha256').update(sourceId).digest('hex')}` });
    if (!result.ok) throw new BridgeError(`Raft send refused (${result.status ?? result.error.kind})`);
    if (result.data.state !== 'sent' || !result.data.messageId) throw new BridgeError(`Raft send not confirmed (${result.data.state})`);
    const messageId = result.data.messageId;
    try {
      const delivery = await this.client.routes.mentions.senderDeliveries({ params: { messageId } });
      if (delivery.ok) log('raft_mention_delivery', { messageId, deliveries: delivery.data.deliveries });
      else log('raft_mention_check_failed', { messageId, status: delivery.status });
    } catch { log('raft_mention_check_failed', { messageId }); }
    return messageId;
  }
  async ensureThread(messageId: string): Promise<string> {
    const target = `${this.cfg.channel}:${messageId.slice(0, 8)}`;
    const followed = await this.client.routes.threads.follow({ body: { thread: target } });
    if (!followed.ok) throw new BridgeError('Raft thread follow failed');
    const resolved = await this.client.routes.channels.resolve({ body: { target } });
    if (!resolved.ok || !resolved.data.channelId) throw new BridgeError('Raft thread resolve failed');
    return resolved.data.channelId;
  }
  async receive(since?: number): Promise<RaftEventsReceiveData> {
    const result = await this.client.events.receive({ since, ack: 'cursor', limit: 100 });
    if (!result.ok) throw new BridgeError(`Raft inbox failed (${result.status ?? result.error.code})`);
    if (result.data.ackMode !== 'cursor') throw new BridgeError('Raft server does not support cursor acknowledgement');
    return result.data;
  }
}
