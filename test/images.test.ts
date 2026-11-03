import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { downloadImage, isPublicAddress, MAX_IMAGE_BYTES } from '../src/images.js';

const key = Buffer.alloc(32, 7);
const image = { url: 'https://wework.qpic.cn/test-encrypted', aeskey: key.toString('base64') };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
function encrypt(bytes: Buffer) {
  const pad = 32 - bytes.length % 32;
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(Buffer.concat([bytes, Buffer.alloc(pad, pad)])), cipher.final()]);
}
const fetchReturning = (body: Buffer) => (async () => new Response(new Uint8Array(body))) as typeof fetch;

test('bounded download uses the official AES decryption and identifies image bytes instead of URL or filename', async () => {
  const received = await downloadImage(image, 0, fetchReturning(encrypt(png)));
  assert.deepEqual(Buffer.from(received.bytes), png);
  assert.equal(received.filename, 'image-1.png');
  assert.equal(received.mimeType, 'image/png');
});

test('invalid/missing key, expired links, corrupt ciphertext and non-image data fail with safe errors', async () => {
  for (const aeskey of [undefined, 'invalid']) await assert.rejects(downloadImage({ ...image, aeskey }, 0), /解密密钥/);
  await assert.rejects(downloadImage(image, 0, (async () => new Response('', { status: 403 })) as typeof fetch), /过期/);
  await assert.rejects(downloadImage(image, 0, fetchReturning(Buffer.from('broken'))), /解密失败/);
  await assert.rejects(downloadImage(image, 0, fetchReturning(encrypt(Buffer.from('<html>not an image</html>')))), /转换格式/);
  await assert.rejects(downloadImage(image, 0, (async () => { throw new Error(`secret ${image.url} ${image.aeskey}`); }) as typeof fetch),
    error => error instanceof Error && !error.message.includes(image.url) && !error.message.includes(image.aeskey));
});

test('download is bounded by both declared length and streamed bytes', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }),
    { headers: { 'content-length': String(MAX_IMAGE_BYTES + 64) } });
  await assert.rejects(downloadImage(image, 0, (async () => response) as typeof fetch), /超过 10 MiB/);
  assert.equal(cancelled, true);
  await assert.rejects(downloadImage(image, 0, fetchReturning(Buffer.alloc(MAX_IMAGE_BYTES + 64))), /超过 10 MiB/);
});

test('media redirects and destinations cannot fetch local endpoints or forward credentials', async () => {
  for (const url of ['file:///tmp/image', 'https://127.0.0.1/image', 'https://localhost/image',
    'https://user:password@wework.qpic.cn/image']) {
    await assert.rejects(downloadImage({ ...image, url }, 0), /公共媒体地址/);
  }
  let requests = 0;
  await assert.rejects(downloadImage(image, 0, (async (_url, init) => {
    requests++; assert.equal(init?.headers, undefined); assert.equal(init?.redirect, 'manual');
    return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } });
  }) as typeof fetch), /公共媒体地址/);
  assert.equal(requests, 1);
});

test('CDN hostnames are not hardcoded and both HTTP and HTTPS encrypted callbacks are supported', async () => {
  for (const url of ['http://cdn.example.test/image', 'https://another-cdn.example.test/image']) {
    const received = await downloadImage({ ...image, url }, 0, fetchReturning(encrypt(png)));
    assert.deepEqual(Buffer.from(received.bytes), png);
  }
});

test('resolved private and special IP ranges are rejected, including IPv4-mapped IPv6', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1',
    '224.0.0.1', '198.18.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('1.1.1.1'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});
