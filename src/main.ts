import { loadConfig } from './config.js';
import { hideSecrets, log, errorKind } from './log.js';
import { createWecom, conversationOf, type MessageFrame } from './wecom.js';
import { RaftConnection } from './raft.js';
import { Bridge } from './bridge.js';
import { PrivateSessions } from './private-sessions.js';
import { openControl, projectRoot } from '../scripts/runtime.mjs';

async function main() {
  process.chdir(projectRoot);
  const mode = process.argv[2] || 'run';
  if (!['run', 'discover', 'check'].includes(mode)) throw new Error('命令仅支持 run / discover / check');
  const cfg = loadConfig(mode);
  hideSecrets([cfg.secret, cfg.credential]);
  const raft = mode === 'discover' ? undefined : new RaftConnection(cfg);
  if (mode === 'check') { await raft!.check(); return; }
  let client: ReturnType<typeof createWecom>['client'] | undefined;
  let bridge: Bridge | undefined;
  let control: Awaited<ReturnType<typeof openControl>> | undefined;
  let stopping = false, timer: ReturnType<typeof setTimeout> | undefined;
  let polling: Promise<void> = Promise.resolve();
  let shutdown: Promise<void> | undefined;
  const stop = () => shutdown ??= (async () => {
    stopping = true; clearTimeout(timer); control?.update('stopping');
    const deadline = setTimeout(() => process.exit(1), 25_000); deadline.unref();
    try { await Promise.all([polling, bridge?.drain()]); }
    finally {
      client?.disconnect(); await control?.close(); clearTimeout(deadline); log('bridge_stopped');
    }
  })();
  control = await openControl(projectRoot, { mode, onStop: stop });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void stop(); });
  try {
    if (raft) await raft.check();
    if (stopping) return;
    const sessions = mode === 'run' ? await PrivateSessions.load(cfg) : undefined;
    if (stopping) return;
    if (sessions) log('private_sessions_loaded', { count: sessions.all().length });
    const wecom = createWecom(cfg);
    client = wecom.client;
    bridge = mode === 'run' ? new Bridge(cfg, raft!, wecom.port, undefined, sessions) : undefined;
    if (bridge) log('bridge_modes', { allowPrivate: cfg.allowPrivate, allowGroup: cfg.allowGroup });
    const tick = () => {
      polling = (async () => {
        let more = false;
        try { more = await bridge!.poll(); }
        catch (error) { log('raft_poll_failed', { kind: errorKind(error) }); }
        if (!stopping) timer = setTimeout(tick, more ? 100 : cfg.pollMs);
      })();
    };
    const onMessage = (frame: MessageFrame) => {
      if (stopping) return;
      if (mode === 'discover') {
        const m = frame.body;
        const conversation = conversationOf(frame);
        if (conversation && m?.aibotid === cfg.botId) log('wecom_conversation_discovered', {
          chatType: conversation.type, chatId: conversation.id, senderId: m.from.userid, messageId: m.msgid, messageType: m.msgtype,
        });
      } else void bridge!.accept(frame).catch(error => log('message_failed', { kind: errorKind(error) }));
    };
    client.on('message.text', onMessage);
    client.on('message.image', onMessage);
    client.on('message.mixed', onMessage);
    let initialized = false;
    client.on('authenticated', () => {
      if (stopping) return;
      control?.update('ready');
      if (bridge && !initialized) { initialized = true; tick(); }
      if (mode === 'discover') log('discover_ready', {
        instruction: '请私聊机器人，或在群里 @机器人 发一句话；本模式只记录会话信息，不转发任务。正常运行无需填写群 ID。',
      });
    });
    client.on('disconnected', () => control?.update('connecting'));
    client.on('reconnecting', () => control?.update('connecting'));
    control.update('connecting');
    client.connect();
  } catch (error) { await stop(); throw error; }
}
main().catch(error => { log('startup_failed', { message: error instanceof Error ? error.message : '启动失败' }); process.exitCode = 1; });
