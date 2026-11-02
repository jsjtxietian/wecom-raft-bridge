let secrets: string[] = [];
export class BridgeError extends Error { override name = 'BridgeError'; }
export function hideSecrets(values: string[]) { secrets = values.filter(Boolean); }
export function log(event: string, fields: Record<string, unknown> = {}) {
  let line = JSON.stringify({ time: new Date().toISOString(), event, ...fields });
  for (const secret of secrets) line = line.split(secret).join('[redacted]');
  console.log(line.replace(/sk_agent_[A-Za-z0-9_-]+/g, '[redacted]'));
}
// SDK errors can contain request bodies. Log only the error class, never raw objects.
export function errorKind(error: unknown) {
  return error instanceof BridgeError ? error.message : error instanceof Error ? error.name : 'UnknownError';
}
