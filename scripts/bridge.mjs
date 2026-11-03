import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectRoot, readStatus, requestStop } from './runtime.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const labels = { starting: '启动中', ready: '企微已认证', connecting: '等待企微连接', stopping: '正在停止' };
const describe = status => `正在运行：PID ${status.pid}，${labels[status.phase] ?? status.phase}${status.mode === 'discover' ? '（发现模式，不转发任务）' : ''}`;

export async function runCommand(command, { root = projectRoot, entry = join(projectRoot, 'src', 'main.ts'),
  output = console.log, startupWaitMs = 10_000 } = {}) {
  if (!['start', 'stop', 'status', 'run'].includes(command)) throw new Error('用法：bridge start | stop | status | run');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('需要 Node.js 22 或更新版本。');
  const current = await readStatus(root);
  if (command === 'status') { output(current ? describe(current) : '未运行。'); return; }
  if (command === 'stop') {
    if (!await requestStop(root)) { output('未运行，无需停止。'); return; }
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (!await readStatus(root)) { output('已停止。'); return; }
      await wait(200);
    }
    throw new Error('停止尚未完成，请检查日志后再运行 status；未强制结束进程。');
  }
  if (current) { output(describe(current)); return; }
  let loader;
  try { loader = import.meta.resolve('tsx'); }
  catch { throw new Error('尚未安装依赖，请在项目目录执行 npm ci。'); }
  if (!existsSync(join(root, '.env'))) output('未找到 .env；如未设置环境变量，请先复制 .env.example 并填写配置。');
  const args = ['--import', loader, entry];
  if (command === 'run') {
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true });
    // Ctrl+C reaches both processes in a terminal; let the worker finish draining.
    const forward = () => { if (process.platform !== 'win32') child.kill('SIGTERM'); };
    process.on('SIGINT', forward); process.on('SIGTERM', forward);
    try {
      await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(new Error('桥接已退出，请查看上方错误。')));
      });
    } finally { process.off('SIGINT', forward); process.off('SIGTERM', forward); }
    return;
  }
  await mkdir(join(root, '.local'), { recursive: true });
  const descriptors = [];
  let child;
  try {
    descriptors.push(openSync(join(root, '.local', 'bridge.stdout.log'), 'a'));
    descriptors.push(openSync(join(root, '.local', 'bridge.stderr.log'), 'a'));
    child = spawn(process.execPath, args, { cwd: root, detached: true, windowsHide: true,
      stdio: ['ignore', ...descriptors] });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } finally { for (const fd of descriptors) closeSync(fd); }
  const deadline = Date.now() + startupWaitMs;
  while (Date.now() < deadline) {
    const status = await readStatus(root);
    if (status?.phase === 'ready') { output(describe(status)); return; }
    if (child.exitCode !== null) throw new Error('启动失败，请查看 .local/bridge.stdout.log 和 bridge.stderr.log。');
    await wait(200);
  }
  const status = await readStatus(root);
  if (!status) throw new Error('尚未确认启动，请查看 .local/bridge.stdout.log 和 bridge.stderr.log。');
  output(describe(status));
  output('可运行 npm run status 查看后续状态；日志位于 .local/。');
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCommand(process.argv[2] || 'start').catch(error => { console.error(error.message); process.exitCode = 1; });
}
