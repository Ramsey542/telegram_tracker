import { createRequire } from 'node:module';

const tokenRequire = createRequire(import.meta.resolve('@solana/spl-token'));
const layoutRequire = createRequire(tokenRequire.resolve('@solana/buffer-layout-utils'));
const fallbackWarning =
  'bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)';
const originalWarn = console.warn;

try {
  console.warn = (...args) => {
    if (args.length === 1 && args[0] === fallbackWarning) return;
    originalWarn.apply(console, args);
  };
  layoutRequire('bigint-buffer');
} finally {
  console.warn = originalWarn;
}
