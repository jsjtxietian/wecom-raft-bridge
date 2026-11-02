import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.js';

const env = { WECOM_BOT_ID: 'bot', WECOM_SECRET: 'test', RAFT_SERVER_URL: 'https://example.test',
  RAFT_AGENT_CREDENTIAL: 'test', RAFT_CHANNEL: '#test', RAFT_TARGET_AGENT: '@Sol', RAFT_EXPECTED_AGENT: '@WeCom' };

test('private and group modes default on without a group id; legacy group id does not bind', () => {
  const config = parseConfig('run', { ...env, WECOM_CHAT_ID: 'old-group' });
  assert.equal(config.allowPrivate, true);
  assert.equal(config.allowGroup, true);
  assert.equal('chatId' in config, false);
  assert.doesNotThrow(() => parseConfig('run', env));
});
test('mode flags accept explicit booleans and reject typos', () => {
  const config = parseConfig('run', { ...env, WECOM_ALLOW_PRIVATE: 'false', WECOM_ALLOW_GROUP: ' FALSE ' });
  assert.equal(config.allowPrivate, false);
  assert.equal(config.allowGroup, false);
  for (const key of ['WECOM_ALLOW_PRIVATE', 'WECOM_ALLOW_GROUP']) {
    assert.throws(() => parseConfig('run', { ...env, [key]: 'ture' }), /true 或 false/);
  }
});
