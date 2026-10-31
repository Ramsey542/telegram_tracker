export function insufficientFunds(error: unknown): boolean {
  const seen = new Set<object>();
  const inspect = (value: unknown, depth: number): boolean => {
    if (typeof value === 'string')
      return /insufficient[\s_-]*(?:funds|balance|lamports)|insufficient\s+(?:native\s+)?(?:eth|weth|token|sol)\s+(?:funds|balance)|transfer amount exceeds balance|erc20insufficientbalance|not enough\s+(?:eth|weth|funds|balance)|amount exceeds (?:the )?(?:available )?balance|(?:balance|funds)[\s_-]*(?:is[\s_-]*)?(?:too[\s_-]*low|not[\s_-]*(?:enough|sufficient))/i.test(
        value,
      );
    if (!value || typeof value !== 'object' || depth > 8 || seen.has(value)) return false;
    seen.add(value);
    if (
      value instanceof Error &&
      (inspect(value.name, depth + 1) || inspect(value.message, depth + 1))
    )
      return true;
    for (const key of [
      'cause',
      'details',
      'responseBody',
      'error',
      'rpcError',
      'data',
      'message',
      'shortMessage',
      'detail',
      'reason',
      'errorCode',
      'errorMessage',
      'originalError',
    ])
      if (key in value && inspect((value as Record<string, unknown>)[key], depth + 1)) return true;
    return false;
  };
  return inspect(error, 0);
}
