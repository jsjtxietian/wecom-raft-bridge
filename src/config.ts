import { config as dotenv } from 'dotenv';

function flag(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = (env[name] ?? 'true').trim().toLowerCase();
  if (value !== 'true' && value !== 'false') throw new Error(`${name} 必须是 true 或 false`);
  return value === 'true';
}

export function loadConfig(mode: string) {
  dotenv({ quiet: true });
  return parseConfig(mode, process.env);
}

export function parseConfig(mode: string, env: NodeJS.ProcessEnv) {
  const cfg = {
    botId: env.WECOM_BOT_ID || '',
    secret: env.WECOM_SECRET || '',
    botName: env.WECOM_BOT_NAME || '',
    allowPrivate: flag(env, 'WECOM_ALLOW_PRIVATE'),
    allowGroup: flag(env, 'WECOM_ALLOW_GROUP'),
    serverUrl: env.RAFT_SERVER_URL || '',
    credential: env.RAFT_AGENT_CREDENTIAL || '',
    channel: env.RAFT_CHANNEL || '',
    targetAgent: env.RAFT_TARGET_AGENT || '',
    expectedAgent: env.RAFT_EXPECTED_AGENT || '',
    pollMs: Number(env.RAFT_POLL_MS || 2000),
  };
  if (cfg.channel && !cfg.channel.startsWith('#')) cfg.channel = `#${cfg.channel}`;
  const required = mode === 'discover' ? ['botId', 'secret'] as const
    : mode === 'check' ? ['serverUrl', 'credential', 'channel', 'targetAgent', 'expectedAgent'] as const
    : ['botId', 'secret', 'serverUrl', 'credential', 'channel', 'targetAgent', 'expectedAgent'] as const;
  for (const key of required) if (!cfg[key]) throw new Error(`缺少配置 ${key}；参见 .env.example。`);
  if (!Number.isInteger(cfg.pollMs) || cfg.pollMs < 1000) throw new Error('RAFT_POLL_MS 必须是至少 1000 的整数');
  for (const [value, name] of [[cfg.targetAgent, 'RAFT_TARGET_AGENT'], [cfg.expectedAgent, 'RAFT_EXPECTED_AGENT']]) {
    if (value && !/^@[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${name} 必须是准确的 @handle`);
  }
  return cfg;
}
export type Config = ReturnType<typeof loadConfig>;
