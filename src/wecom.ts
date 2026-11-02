import { createHash } from 'node:crypto';
import { WSClient, type WsFrame, type TextMessage } from '@wecom/aibot-node-sdk';
import type { Config } from './config.js';
import { log, errorKind } from './log.js';

export type TextFrame = WsFrame<TextMessage>;
export interface WecomPort {
  acknowledge(frame: TextFrame, content: string): Promise<void>;
  send(chatId: string, content: string): Promise<void>;
}

export function cleanText(content: string, botId: string, botName: string): string {
  // Only remove the configured bot's leading mention. Preserve email/code/other @names.
  let text = content.trim();
  for (const name of [botId, botName].filter(Boolean)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`^(?:<@!?${escaped}>|@${escaped})(?=[\\s\\u2005\\u200b]|$)[\\s\\u2005\\u200b]*`, 'u'), '');
  }
  return text.trim();
}

export function splitText(text: string, maxBytes = 3500): string[] {
  const chunks: string[] = [];
  let current = '', bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (size > maxBytes) throw new Error('maxBytes too small');
    if (bytes + size > maxBytes) { chunks.push(current); current = ''; bytes = 0; }
    current += char; bytes += size;
  }
  if (current) chunks.push(current);
  return chunks;
}

export function createWecom(cfg: Config, wsUrl?: string) {
  const client = new WSClient({
    botId: cfg.botId, secret: cfg.secret, maxReconnectAttempts: -1, wsUrl,
    logger: { debug() {}, info() {}, warn() { log('wecom_sdk_warning'); }, error() { log('wecom_sdk_error'); } },
  });
  client.on('connected', () => log('wecom_connected'));
  client.on('authenticated', () => log('wecom_authenticated'));
  client.on('disconnected', () => log('wecom_disconnected'));
  client.on('reconnecting', (attempt) => log('wecom_reconnecting', { attempt }));
  client.on('error', (error) => log('wecom_error', { kind: errorKind(error) }));
  const checked = async (receipt: Promise<WsFrame>) => {
    const result = await receipt;
    if (result.errcode !== 0) throw new Error('WeCom receipt not successful');
  };
  const port: WecomPort = {
    acknowledge: (frame, content) => checked(client.replyStream(frame,
      createHash('sha256').update(frame.body?.msgid || frame.headers.req_id).digest('hex').slice(0, 32), content, true)),
    send: (chatId, content) => checked(client.sendMessage(chatId, { msgtype: 'markdown', markdown: { content } })),
  };
  return { client, port };
}
