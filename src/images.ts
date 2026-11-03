import { decryptFile } from '@wecom/aibot-node-sdk';
import { inferAttachmentMimeType } from '@botiverse/raft-sdk';
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';

export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_MESSAGE_IMAGE_BYTES = 20 * 1024 * 1024;
export interface ImageReference { url: string; aeskey?: string; }
export interface ImageUpload { filename: string; bytes: Uint8Array; mimeType: string; }
export class ImageTransferError extends Error {
  override name = 'ImageTransferError';
}

export function isPublicAddress(address: string) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number) as [number, number, number, number];
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  const normalized = address.toLowerCase();
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/.test(normalized)
    && !/^2001:(?:0:|db8:)/.test(normalized) && !normalized.startsWith('2002:');
}

function checkedUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new ImageTransferError('图片下载地址无效，请重新发送图片。'); }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
    || (url.port && !['80', '443'].includes(url.port)) || hostname === 'localhost' || hostname.endsWith('.localhost')
    || hostname.endsWith('.local') || (isIP(hostname) && !isPublicAddress(hostname))) {
    throw new ImageTransferError('图片下载地址不是有效的公共媒体地址，请重新发送图片。');
  }
  return url;
}

// Pin the validated DNS answer to the connection, preserving the URL's TLS hostname.
// WeCom may return encrypted bytes over HTTP or HTTPS and use different CDN domains.
const fetchPublicMedia: typeof fetch = async (input, init) => {
  const url = checkedUrl(String(input)), hostname = url.hostname.replace(/^\[|\]$/g, '');
  const signal = init?.signal;
  signal?.throwIfAborted();
  let abortLookup: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortLookup = () => reject(new Error('Media lookup aborted'));
    signal?.addEventListener('abort', abortLookup, { once: true });
  });
  let addresses;
  try { addresses = await Promise.race([lookup(hostname, { all: true }), aborted]); }
  finally { if (abortLookup) signal?.removeEventListener('abort', abortLookup); }
  if (!addresses.length || addresses.some(entry => !isPublicAddress(entry.address))) {
    throw new ImageTransferError('图片下载地址指向非公共网络，无法读取。');
  }
  const address = addresses.sort((a, b) => a.family - b.family)[0]!;
  return new Promise<Response>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      agent: false, signal: signal ?? undefined, family: address.family,
      lookup: (_host, _options, done) => done(null, address.address, address.family),
    }, response => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else if (value !== undefined) headers.set(name, value);
      }
      const status = response.statusCode ?? 500;
      const body = [204, 205, 304].includes(status) ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>;
      if (!body) response.resume();
      resolve(new Response(body, { status, headers }));
    });
    request.on('error', reject); request.end();
  });
};

export async function downloadImage(image: ImageReference, index: number, fetcher: typeof fetch = fetchPublicMedia): Promise<ImageUpload> {
  if (typeof image?.aeskey !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.aeskey)
    || Buffer.from(image.aeskey, 'base64').length !== 32) {
    throw new ImageTransferError('图片缺少有效的解密密钥，请重新发送图片。');
  }
  try {
    let url = checkedUrl(image.url);
    const signal = AbortSignal.timeout(15_000);
    let response: Response | undefined;
    for (let redirects = 0; redirects <= 3; redirects++) {
      response = await fetcher(url, { redirect: 'manual', signal });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects === 3) throw new ImageTransferError('图片下载跳转异常，请重新发送图片。');
      url = checkedUrl(new URL(location, url).href);
    }
    if (!response?.ok || !response.body) {
      await response?.body?.cancel();
      throw new ImageTransferError('图片下载失败或链接已过期，请重新发送图片。');
    }
    const maxEncryptedBytes = MAX_IMAGE_BYTES + 32;
    if (Number(response.headers.get('content-length')) > maxEncryptedBytes) {
      await response.body.cancel();
      throw new ImageTransferError('图片超过 10 MiB，请压缩后重新发送。');
    }
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxEncryptedBytes) throw new ImageTransferError('图片超过 10 MiB，请压缩后重新发送。');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    let bytes: Buffer;
    try { bytes = decryptFile(Buffer.concat(chunks), image.aeskey); }
    catch { throw new ImageTransferError('图片解密失败，请重新发送图片。'); }
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new ImageTransferError('图片为空或超过 10 MiB，请重新发送。');
    const mimeType = inferAttachmentMimeType('', bytes);
    const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' } as Record<string, string>)[mimeType];
    if (!extension) throw new ImageTransferError('暂时支持 PNG、JPEG、GIF、WebP 图片，请转换格式后重发。');
    return { bytes, mimeType, filename: `image-${index + 1}.${extension}` };
  } catch (error) {
    if (error instanceof ImageTransferError) throw error;
    // Download URLs and per-image keys must never escape through SDK/fetch errors.
    throw new ImageTransferError('图片下载失败或超时，请重新发送图片。');
  }
}
