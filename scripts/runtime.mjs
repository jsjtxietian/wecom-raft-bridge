import { createHash, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const app = 'wecom-raft-bridge';
const canonical = root => process.platform === 'win32' ? realpathSync(root).toLowerCase() : realpathSync(root);
export const controlFile = root => join(root, '.local', 'bridge-control.json');
// Binding is atomic across processes. A stale PID file never authorizes killing a process.
export const controlPort = root => 40000 + parseInt(createHash('sha256').update(canonical(root)).digest('hex').slice(0, 8), 16) % 20000;

export async function openControl(root, { mode = 'run', onStop }) {
  const token = randomBytes(32).toString('hex');
  const state = { app, root: canonical(root), pid: process.pid, mode, phase: 'starting', startedAt: new Date().toISOString() };
  let closing;
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'GET' && req.url === '/status') { res.end(JSON.stringify(state)); return; }
    if (req.method === 'POST' && req.url === '/stop' && req.headers.authorization === `Bearer ${token}`) {
      state.phase = 'stopping';
      res.writeHead(202); res.end('{}');
      void Promise.resolve().then(onStop).catch(() => {});
      return;
    }
    res.writeHead(403); res.end('{}');
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.timeout = 5000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: controlPort(root), exclusive: true }, () => {
      server.removeListener('error', reject); resolve();
    });
  }).catch(error => {
    if (error.code === 'EADDRINUSE') throw new Error('本目录的桥接已运行，或本地控制端口被占用。请运行 npm run status。');
    throw new Error('无法建立本地启动管理端口。');
  });
  const close = () => closing ??= (async () => {
    // Keep the port until cleanup completes so another instance cannot race the state file.
    try {
      const saved = JSON.parse(await readFile(controlFile(root), 'utf8'));
      if (saved.token === token) await unlink(controlFile(root));
    } catch { /* A missing state file does not affect the process lock. */ }
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  })();
  try {
    await mkdir(join(root, '.local'), { recursive: true });
    const temporary = `${controlFile(root)}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ ...state, token }) + '\n', { mode: 0o600, flush: true });
    await rename(temporary, controlFile(root));
  } catch {
    await close();
    throw new Error('无法写入 .local/bridge-control.json，请检查目录权限。');
  }
  return { close, update: phase => { if (state.phase !== 'stopping') state.phase = phase; } };
}

function query(root, method, path, token) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: controlPort(root), method, path, agent: false,
      headers: token ? { Authorization: `Bearer ${token}` } : {}, timeout: 1500 }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        data += chunk;
        if (data.length > 8192) req.destroy(new Error('本地控制端口返回了未知数据。'));
      });
      res.on('error', reject);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { reject(new Error('本地控制端口已被其他程序占用。')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('桥接控制端口无响应，请检查日志。')));
    req.on('error', error => {
      if (error.code === 'ECONNREFUSED') resolve(null);
      else reject(error);
    });
    req.end();
  });
}

export async function readStatus(root = projectRoot) {
  const result = await query(root, 'GET', '/status');
  if (!result) return null;
  if (result.status !== 200 || result.data.app !== app || result.data.root !== canonical(root)) {
    throw new Error('本地控制端口已被其他程序占用，未操作该程序。');
  }
  return result.data;
}

export async function requestStop(root = projectRoot) {
  if (!await readStatus(root)) return false;
  let saved;
  try { saved = JSON.parse(await readFile(controlFile(root), 'utf8')); }
  catch { throw new Error('无法读取本地停止凭据；请在原终端按 Ctrl+C，不要按 PID 强制结束其他进程。'); }
  if (saved.root !== canonical(root) || typeof saved.token !== 'string') throw new Error('本地停止凭据无效。');
  const result = await query(root, 'POST', '/stop', saved.token);
  if (result && result.status !== 202) throw new Error('停止凭据已失效，请重新运行 npm run stop。');
  return true;
}
