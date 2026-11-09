import { z } from 'zod';
import { ReviewRequired } from '../domain.js';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const quantity = z.string().regex(/^(?:0x[0-9a-fA-F]+|\d+)$/);
const frameSchema = z.object({
  type: z.enum([
    'CALL',
    'STATICCALL',
    'DELEGATECALL',
    'CALLCODE',
    'CREATE',
    'CREATE2',
    'SELFDESTRUCT',
  ]),
  from: address,
  to: address.optional(),
  value: quantity.optional(),
  error: z.string().optional(),
  calls: z.array(z.unknown()).optional(),
});

export function tracedNativeDelta(
  trace: unknown,
  wallet: string,
  destination: string,
  transactionValue: string,
): bigint {
  const parsed = frameSchema.safeParse(trace);
  if (!parsed.success)
    throw new ReviewRequired('QuickNode returned an invalid native transfer trace');
  const root = parsed.data;
  const owner = wallet.toLowerCase();
  if (
    root.error ||
    root.type !== 'CALL' ||
    root.from.toLowerCase() !== owner ||
    root.to?.toLowerCase() !== destination.toLowerCase() ||
    BigInt(root.value ?? '0') !== BigInt(transactionValue) ||
    !root.calls
  )
    throw new ReviewRequired('Native transfer trace does not match the confirmed Flap transaction');
  let delta = 0n;
  const pending: { frame: unknown; depth: number }[] = [{ frame: root, depth: 0 }];
  let visited = 0;
  while (pending.length) {
    const entry = pending.pop()!;
    if (entry.depth > 128 || ++visited > 10000)
      throw new ReviewRequired('Native transfer trace exceeds the supported size or depth');
    const decoded = frameSchema.safeParse(entry.frame);
    if (!decoded.success)
      throw new ReviewRequired('QuickNode returned an invalid native transfer trace');
    const frame = decoded.data;
    if (frame.error) continue;
    if (['CALL', 'CREATE', 'CREATE2', 'SELFDESTRUCT'].includes(frame.type)) {
      const value = BigInt(frame.value ?? '0');
      if (frame.from.toLowerCase() === owner) delta -= value;
      if (frame.to?.toLowerCase() === owner) delta += value;
    }
    for (const child of frame.calls ?? []) pending.push({ frame: child, depth: entry.depth + 1 });
  }
  return delta;
}
