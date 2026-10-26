// Import compiled modules without invoking main(), opening wallets, or starting the bot.
await Promise.all([
  import('../dist/chains/solana.js'),
  import('../dist/chains/robinhood.js'),
  import('../dist/telegram/bot.js'),
  import('../dist/telegram/reader.js'),
]);
console.info('Compiled adapters and Telegram modules loaded successfully.');
