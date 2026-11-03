import { createHash } from 'node:crypto';
import { WSClient, type WsFrame, type TextMessage, type ImageMessage, type MixedMessage, type ImageContent } from '@wecom/aibot-node-sdk';
import type { Config } from './config.js';
import { log, errorKind } from './log.js';
import { downloadImage, MAX_IMAGES, ImageTransferError, type ImageReference, type ImageUpload } from './images.js';

export type TextFrame = WsFrame<TextMessage>;
export type MessageFrame = WsFrame<TextMessage | ImageMessage | MixedMessage>;
export interface Conversation { type: 'single' | 'group'; id: string; }
export function conversationOf(frame: MessageFrame): Conversation | undefined {
  const m = frame.body;
  if (!m || (m.chattype !== 'single' && m.chattype !== 'group')) return;
  // Private callbacks have no chatid. The official SDK accepts userid as the send target.
  const id = m.chattype === 'single' ? m.from?.userid : m.chatid;
  if (typeof id !== 'string' || !id.trim()) return;
  return { type: m.chattype, id };
}
export interface WecomPort {
  acknowledge(frame: MessageFrame, content: string): Promise<void>;
  send(chatId: string, content: string): Promise<void>;
  downloadImage(image: ImageReference, index: number): Promise<ImageUpload>;
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

export function withQuote(question: string, quote: TextMessage['quote'], collectImage?: (image: ImageContent | undefined) => void): string {
  if (!quote) return question;
  const textOf = (value: unknown) => typeof value === 'string' ? value.trim() : '';
  let context = '';
  let hasImage = false;
  const attachImage = (image: ImageContent | undefined) => { collectImage!(image); hasImage = true; return ''; };
  if (quote.msgtype === 'text') context = textOf(quote.text?.content);
  else if (quote.msgtype === 'image' && collectImage) context = attachImage(quote.image);
  else if (quote.msgtype === 'mixed' && Array.isArray(quote.mixed?.msg_item)) {
    context = quote.mixed.msg_item.map(item => item?.msgtype === 'text'
      ? textOf(item.text?.content) : item?.msgtype === 'image' && collectImage
        ? attachImage(item.image) : '（引用中的非文字内容未读取）').filter(Boolean).join('\n');
  }
  if (!context && hasImage) return question;
  if (!context) context = quote.msgtype === 'text'
    ? '（引用文字为空或无法读取）' : '（此类型的引用暂未读取；当前仅支持文字和图文中的文字）';
  // Historical mentions are context, not new wake-ups. Keep email addresses intact.
  const quoted = context.replace(/\r\n?/g, '\n').replace(/(?<![A-Za-z0-9._%+-])@(?=[A-Za-z0-9_-])/g, '＠')
    .split('\n').map(line => `> ${line}`).join('\n');
  return `引用内容：\n${quoted}\n\n本次提问：\n${question}`;
}

export function messageContent(frame: MessageFrame, botId: string, botName: string) {
  const m = frame.body;
  if (!m) return;
  const images: ImageReference[] = [];
  const collectImage = (image: ImageContent | undefined) => {
    if (!image || typeof image.url !== 'string') throw new ImageTransferError('图片信息不完整，请重新发送图片。');
    images.push({ url: image.url, aeskey: image.aeskey });
    if (images.length > MAX_IMAGES) throw new ImageTransferError('每条消息最多支持 4 张图片，请分开发送。');
  };
  let content: string;
  if (m.msgtype === 'text' && typeof m.text?.content === 'string') content = m.text.content;
  else if (m.msgtype === 'image') { collectImage(m.image); content = ''; }
  else if (m.msgtype === 'mixed' && Array.isArray(m.mixed?.msg_item)) {
    content = m.mixed.msg_item.map(item => {
      if (item?.msgtype === 'text' && typeof item.text?.content === 'string') return item.text.content;
      if (item?.msgtype === 'image') collectImage(item.image);
      return '';
    }).filter(Boolean).join('\n');
  } else return;
  content = cleanText(content, botId, botName);
  if (!content && images.length) content = '请查看图片，并结合当前对话回答。';
  // A quote alone is not a task. The user's current text/images must supply the request.
  const task = content ? withQuote(content, m.quote, collectImage) : '';
  return { content, task, images };
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
    downloadImage,
    acknowledge: (frame, content) => checked(client.replyStream(frame,
      createHash('sha256').update(frame.body?.msgid || frame.headers.req_id).digest('hex').slice(0, 32), content, true)),
    send: (chatId, content) => checked(client.sendMessage(chatId, { msgtype: 'markdown', markdown: { content } })),
  };
  return { client, port };
}
