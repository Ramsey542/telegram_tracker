const secrets = new Set<string>();
const confidentialKeys = new Set([
  'authorization',
  'proxyauthorization',
  'xapikey',
  'apikey',
  'apihash',
  'telegramapihash',
  'telegramapiid',
  'telegramphone',
  'phone',
  'phonenumber',
  'password',
  'phonecode',
  'verificationcode',
  'logincode',
  'privatekey',
  'secretkey',
  'encryptionkey',
  'walletencryptionkey',
  'bottoken',
  'accesstoken',
  'refreshtoken',
  'jupiterkey',
  'uniswapkey',
  'rugcheckkey',
  'goplustoken',
  'goplusappkey',
  'goplusappsecret',
  'appkey',
  'appsecret',
  'sign',
  'solanarpc',
  'robinhoodrpc',
  'session',
  'sessionstring',
  'serialized',
  'signedtransaction',
  'rawtransaction',
  'ciphertext',
  'signaturedata',
  'cosignature',
]);
const signedMethods = new Set([
  'sendTransaction',
  'eth_sendRawTransaction',
  'sendRawTransaction',
  'sendBundle',
  'simulateTransaction',
  'simulateBundle',
]);

export function registerSecrets(values: Iterable<string>): void {
  for (const value of values)
    if (value.length >= 6) {
      secrets.add(value);
      secrets.add(encodeURIComponent(value));
    }
}

export function safeEndpoint(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    if (url.hostname.endsWith('.quiknode.pro'))
      url.pathname = url.pathname === '/' ? '/' : '/[redacted]';
    if (url.hostname === 'api.telegram.org')
      url.pathname = url.pathname.replace(/\/bot[^/]+/, '/bot[redacted]');
    for (const key of [...url.searchParams.keys()])
      if (/key|token|secret|auth|signature|password/i.test(key))
        url.searchParams.set(key, '[redacted]');
    return url.toString().replaceAll('%5Bredacted%5D', '[redacted]');
  } catch {
    return '[invalid endpoint]';
  }
}

export function redactText(value: string, publicSignalId = false): string {
  let result = value;
  for (const secret of secrets) result = result.split(secret).join('[redacted]');
  result = result
    .replace(/https?:\/\/[^\s"'<>]+/gi, safeEndpoint)
    .replace(/\b(?:jup_|sk-)[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/\b\d{6,}:[A-Za-z0-9_-]+/g, (match) => (publicSignalId ? match : '[redacted]'))
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[redacted]')
    .replace(
      /((?:api[_-]?key|api[_-]?hash|app[_-]?key|app[_-]?secret|access[_-]?token|refresh[_-]?token|sign|password|private[_-]?key|secret[_-]?key|signedTransaction|serialized|authorization)["']?\s*[:=]\s*["']?)[^\s,"'\]}]+/gi,
      '$1[redacted]',
    )
    .replace(/((?:login|verification|phone|sms)\s*code\s*[:=]\s*)\d{4,8}/gi, '$1[redacted]')
    .replace(/0x[a-fA-F0-9]{130,}/g, '[redacted encoded data]')
    .replace(/\b[A-Za-z0-9+/]{160,}={0,2}/g, '[redacted encoded data]')
    .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\u200d\ufe0f]/gu, '');
  return result.length > 16_384
    ? `${result.slice(0, 16_384)}[truncated ${result.length - 16_384} characters]`
    : result;
}

export function redact(value: unknown, key = '', seen = new WeakSet<object>(), depth = 0): unknown {
  if (confidentialKeys.has(key.replace(/[-_]/g, '').toLowerCase())) return '[redacted]';
  if (
    key.toLowerCase() === 'signature' &&
    typeof value === 'string' &&
    /^0x[0-9a-f]{130}$/i.test(value)
  )
    return '[redacted signature]';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') {
    if (/^\s*[\[{]/.test(value)) {
      try {
        return redact(JSON.parse(value), '', seen, depth + 1);
      } catch {
        return redactText(value);
      }
    }
    const publicSignalId = (key === 'signalId' || key === 'id') && /^-\d+:\d+$/.test(value);
    return redactText(value, publicSignalId);
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol')
    return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (depth > 12) return '[maximum depth]';
  if (value instanceof Uint8Array) return `[binary ${value.byteLength} bytes]`;
  if (value instanceof Date) return value.toISOString();
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (value instanceof Error) {
    const result: Record<string, unknown> = {
      name: value.name,
      message: value.message,
      stack: value.stack,
      cause: value.cause,
    };
    for (const property of Object.getOwnPropertyNames(value))
      if (!(property in result))
        result[property] = (value as unknown as Record<string, unknown>)[property];
    return Object.fromEntries(
      Object.entries(result).map(([property, entry]) => [
        property,
        redact(entry, property, seen, depth + 1),
      ]),
    );
  }
  if (Array.isArray(value))
    return value.slice(0, 200).map((entry) => redact(entry, '', seen, depth + 1));
  const record = value as Record<string, unknown>;
  const redactParams = typeof record.method === 'string' && signedMethods.has(record.method);
  return Object.fromEntries(
    Object.entries(record).map(([property, entry]) => [
      property,
      property === 'params' && redactParams
        ? '[redacted transaction payload]'
        : redact(entry, property, seen, depth + 1),
    ]),
  );
}
