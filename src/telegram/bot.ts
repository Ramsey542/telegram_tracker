import { Bot, InlineKeyboard, type Context } from 'grammy';
import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from '../config.js';
import {
  chains,
  chainSettingsSchema,
  emptyTrail,
  formatAmount,
  nativeDecimals,
  nativeSymbol,
  type Chain,
  type ChainSettings,
} from '../domain.js';
import { Store } from '../infra/store.js';
import { safeError } from '../infra/http.js';
import { TradeEngine } from '../trading/engine.js';
import { applyField, editableFields, toggles, type EditableField } from './settings.js';

type PendingInput =
  | { kind: 'field'; chain: Chain; field: string }
  | { kind: 'tp'; chain: Chain }
  | { kind: 'block'; remove: boolean };
const label = (value: string): string => value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 60);
const onOff = (value: boolean): string => (value ? 'On' : 'Off');
const chainValue = (value: string | undefined): Chain => {
  if (value !== 'solana' && value !== 'robinhood') throw new Error('Unknown chain');
  return value;
};
const groupValue = (value: string | undefined): EditableField['group'] => {
  if (!['buy', 'consistency', 'filters', 'exits', 'execution'].includes(value ?? ''))
    throw new Error('Unknown menu');
  return value as EditableField['group'];
};
export class ControlBot {
  readonly bot: Bot;
  private pending: PendingInput | null = null;
  private sale: { id: string; percentage: number; balance: string; expires: number } | null = null;
  private notifier: ReturnType<typeof setInterval> | null = null;
  private sending = false;
  private notificationCooldown = 0;
  constructor(
    private readonly config: Config,
    private readonly store: Store,
    private readonly engine: TradeEngine,
  ) {
    this.bot = new Bot(config.botToken);
    this.bot.use(async (ctx, next) => {
      if (ctx.from?.id === config.ownerId && ctx.chat?.type === 'private') await next();
    });
    this.bot.command(['start', 'settings'], (ctx) => this.home(ctx));
    this.bot.command('wallets', (ctx) => this.wallets(ctx));
    this.bot.command('positions', (ctx) => this.positions(ctx, 0));
    this.bot.command('history', (ctx) => this.history(ctx));
    this.bot.command('pause', async (ctx) => {
      this.engine.pause();
      await ctx.reply(
        'New entries paused. Configured exits and already submitted trades continue.',
      );
      await this.home(ctx);
    });
    this.bot.command('resume', async (ctx) => {
      try {
        await this.engine.resume();
        await this.home(ctx);
      } catch (error) {
        await ctx.reply(safeError(error));
      }
    });
    this.bot.command('cancel', async (ctx) => {
      this.pending = null;
      this.sale = null;
      await this.home(ctx);
    });
    this.bot.command('help', (ctx) =>
      ctx.reply(
        'Use /settings to configure each chain, /wallets for funding addresses, /positions to inspect or sell positions, /history for trade history, /pause to stop new entries, /resume to enable configured entries, and /cancel to cancel an input.\n\nBuy sizes, slippage and fee budgets must be set before enabling a chain. All three consistency thresholds start at 30%. Entry filters and exits start disabled. Profit targets use fresh SOL/ETH quotes against entry spending, including recorded entry fees. Future sell network fees are shown in confirmed proceeds; fills follow your slippage setting. Fixed TP sell percentages refer to the original entry; trailing TP percentages refer to the remaining balance.\n\nSettings changes apply to future positions. Each position has an explicit Apply current exit settings action. No withdrawal or private-key export is provided.',
      ),
    );
    this.bot.on('callback_query:data', async (ctx) => {
      try {
        await ctx.answerCallbackQuery();
        await this.callback(ctx, ctx.callbackQuery.data);
      } catch (error) {
        await ctx.reply(safeError(error));
      }
    });
    this.bot.on('message:text', async (ctx) => {
      try {
        await this.text(ctx, ctx.message.text);
      } catch (error) {
        await ctx.reply(safeError(error));
      }
    });
    this.bot.catch((error) => {
      console.error(
        JSON.stringify({ event: 'telegram_control_error', message: safeError(error.error) }),
      );
    });
  }
  private async display(ctx: Context, text: string, keyboard: InlineKeyboard): Promise<void> {
    const options = { reply_markup: keyboard, link_preview_options: { is_disabled: true } };
    if (ctx.callbackQuery?.message) {
      try {
        await ctx.editMessageText(text.slice(0, 3900), options);
        return;
      } catch (error) {
        if (safeError(error).includes('message is not modified')) return;
      }
    }
    await ctx.reply(text.slice(0, 3900), options);
  }
  private async home(ctx: Context): Promise<void> {
    this.pending = null;
    const settings = this.store.settings();
    const reader = this.store.metadata('reader:last-success');
    const pending = chains
      .map((chain) => this.store.activeOperation(chain))
      .filter((operation) => operation !== null);
    const text = `SpyDefi tracker\n\nSource: @${this.config.sourceChannel}\nNew entries: ${settings.tradingEnabled ? 'Enabled' : 'Paused'}\nReader checked: ${reader ? new Date(Number(reader)).toISOString() : 'Connecting'}\nOpen positions: ${this.store.positions().length}\n\n${chains.map((chain) => `${nativeSymbol[chain]}: ${onOff(settings.chains[chain].enabled)} | Buy size: ${settings.chains[chain].buySizeNative ?? 'Unset'}`).join('\n')}${pending.length ? `\n\nActive operations:\n${pending.map((operation) => `${operation.chain}: ${operation.status} - ${operation.error ?? operation.kind}`).join('\n')}` : ''}`;
    const keyboard = new InlineKeyboard()
      .text('Solana settings', 'chain:solana')
      .text('Robinhood settings', 'chain:robinhood')
      .row()
      .text('Wallets', 'wallets')
      .text('Positions', 'positions:0')
      .row()
      .text('Caller blocklist', 'blocklist')
      .text('History', 'history')
      .row()
      .text(
        settings.tradingEnabled ? 'Pause new entries' : 'Resume new entries',
        settings.tradingEnabled ? 'pause' : 'resume',
      )
      .text('Recent calls', 'recent');
    for (const operation of pending)
      if (operation.status === 'review')
        keyboard.row().text(`Reconcile ${operation.chain}`, `reconcile:${operation.id}`);
    await this.display(ctx, text, keyboard);
  }
  private async chainMenu(ctx: Context, chain: Chain): Promise<void> {
    const settings = this.store.settings().chains[chain];
    const missing = this.engine.readiness(chain);
    const text = `${nativeSymbol[chain]} settings\n\nChain entries: ${onOff(settings.enabled)}\nBuy size: ${settings.buySizeNative ?? 'Unset'} ${nativeSymbol[chain]}\nConsistency: overall ${settings.consistency.overall}%, recent ${settings.consistency.recent}%, chain ${settings.consistency.chain}%\n\n${missing.length ? `Still needed: ${missing.join(', ')}` : 'Ready to enable entries.'}\n\nMarket cap and token safety are together under Entry filters. Exits remain disabled until configured and enabled.`;
    const keyboard = new InlineKeyboard()
      .text('Buy size', `menu:${chain}:buy`)
      .text('Consistency', `menu:${chain}:consistency`)
      .row()
      .text('Entry filters', `menu:${chain}:filters`)
      .text('SL / TP / trailing', `menu:${chain}:exits`)
      .row()
      .text('Slippage / fees / MEV', `menu:${chain}:execution`)
      .row()
      .text(settings.enabled ? 'Disable chain entries' : 'Enable chain entries', `enable:${chain}`)
      .row()
      .text('Back', 'home');
    await this.display(ctx, text, keyboard);
  }
  private async group(ctx: Context, chain: Chain, group: EditableField['group']): Promise<void> {
    const settings = this.store.settings().chains[chain];
    const keyboard = new InlineKeyboard();
    const title = {
      buy: 'Buy size',
      consistency: 'Consistency thresholds',
      filters: 'Entry filters: market cap and token safety',
      exits: 'Stop loss, take profit and trailing',
      execution: 'Slippage, fees and MEV protection',
    }[group];
    const lines = [title, `Chain: ${nativeSymbol[chain]}`, ''];
    for (const [key, field] of Object.entries(editableFields)) {
      if (field.group !== group || (field.chains && !field.chains.includes(chain))) continue;
      const value = field.value(settings);
      lines.push(`${field.label}: ${value ?? 'Unset'}`);
      keyboard.text(field.label, `edit:${chain}:${key}`).row();
    }
    for (const [key, toggle] of Object.entries(toggles)) {
      if (toggle.group !== group || (toggle.chains && !toggle.chains.includes(chain))) continue;
      lines.push(`${toggle.label}: ${onOff(toggle.value(settings))}`);
      keyboard
        .text(`${toggle.label}: ${onOff(toggle.value(settings))}`, `toggle:${chain}:${key}`)
        .row();
    }
    if (group === 'exits') {
      lines.push('', 'Fixed TP stages sell percentages of the original entry:');
      for (const tier of [...settings.exits.takeProfits].sort(
        (a, b) => a.profitPercent - b.profitPercent,
      )) {
        lines.push(
          `+${tier.profitPercent}%: ${tier.sellPercent === 'rest' ? 'sell remaining' : `sell ${tier.sellPercent}%`}`,
        );
        keyboard.text(`Remove +${tier.profitPercent}% TP`, `deltp:${chain}:${tier.id}`).row();
      }
      keyboard.text('Add TP stage', `addtp:${chain}`).row();
      lines.push(
        '',
        'Set values, then enable the desired exits. Trailing activates at its profit threshold and can sell before a later fixed TP. Changes apply to new positions; open positions have a separate apply action.',
      );
    }
    if (group === 'filters')
      lines.push(
        '',
        'MC uses current data at buy time. Missing data rejects the buy while a corresponding check is enabled. Optional numeric limits activate when set; send off to remove them.',
      );
    if (group === 'execution')
      lines.push(
        '',
        chain === 'solana'
          ? 'Protected swaps use QuickNode Lil JIT. Set a Jito tip and enable the add-on on your endpoint.'
          : 'Protected swaps require a UniswapX route. ETH is wrapped for the buy, and sale proceeds are unwrapped back to ETH. No public AMM fallback while protection is on.',
      );
    await this.display(ctx, lines.join('\n'), keyboard.text('Back', `chain:${chain}`));
  }
  private async wallets(ctx: Context): Promise<void> {
    const lines = [
      'Trading wallets',
      '',
      'Generated locally on first startup and reused on subsequent starts.',
      '',
    ];
    for (const chain of chains) {
      lines.push(`${nativeSymbol[chain]} address:`, this.engine.adapters[chain].address);
      try {
        const balance = await this.engine.adapters[chain].balance();
        lines.push(
          `Balance: ${formatAmount(balance.nativeRaw, nativeDecimals[chain])} ${nativeSymbol[chain]}`,
        );
        if (balance.wrappedRaw !== null)
          lines.push(`Wrapped balance: ${formatAmount(balance.wrappedRaw, 18)} WETH`);
      } catch (error) {
        lines.push(`Balance unavailable: ${safeError(error)}`);
      }
      lines.push('');
    }
    await this.display(
      ctx,
      lines.join('\n'),
      new InlineKeyboard()
        .text('Unwrap idle Robinhood WETH', 'unwrap')
        .row()
        .text('Refresh', 'wallets')
        .text('Back', 'home'),
    );
  }
  private async positions(ctx: Context, page: number): Promise<void> {
    const positions = this.store.positions();
    const start = Math.max(0, page) * 5;
    const visible = positions.slice(start, start + 5);
    const keyboard = new InlineKeyboard();
    const lines = ['Open positions', ''];
    for (const position of visible) {
      lines.push(
        `${label(position.symbol)} (${position.chain})`,
        `${formatAmount(position.remainingTokenRaw, position.decimals)} tokens | ${position.lastProfitPercent === null ? 'Value not refreshed' : `${position.lastProfitPercent.toFixed(2)}% in ${nativeSymbol[position.chain]}`}`,
        '',
      );
      keyboard.text(`${label(position.symbol)} - manage`, `position:${position.id}`).row();
    }
    if (positions.length === 0) lines.push('No positions yet.');
    if (page > 0) keyboard.text('Previous', `positions:${page - 1}`);
    if (start + 5 < positions.length) keyboard.text('Next', `positions:${page + 1}`);
    await this.display(ctx, lines.join('\n'), keyboard.row().text('Back', 'home'));
  }
  private async position(ctx: Context, id: string, refresh = false): Promise<void> {
    let position = this.store.position(id);
    if (!position) throw new Error('Position not found');
    if (refresh && position.closedAt === null) position = await this.engine.refresh(position);
    const keyboard = new InlineKeyboard().text('Refresh value', `refresh:${id}`).row();
    if (position.closedAt === null)
      keyboard
        .text('Sell 25%', `sell:${id}:25`)
        .text('Sell 50%', `sell:${id}:50`)
        .text('Sell all', `sell:${id}:100`)
        .row()
        .text('Apply current exit settings', `apply:${id}`)
        .row();
    const exits = position.exits;
    const currentValue =
      position.lastValueNativeRaw === null
        ? ''
        : `\nQuoted remaining value: ${formatAmount(position.lastValueNativeRaw, nativeDecimals[position.chain])} ${nativeSymbol[position.chain]}${position.lastValueUsd === null ? '' : ` (approximately $${position.lastValueUsd.toFixed(2)})`}`;
    await this.display(
      ctx,
      `${label(position.symbol)} (${position.chain})\n${position.address}\n\nRemaining: ${formatAmount(position.remainingTokenRaw, position.decimals)} tokens\nEntry spending: ${formatAmount(position.entryNativeRaw, nativeDecimals[position.chain])} ${nativeSymbol[position.chain]}${position.entryUsd === null ? '' : `\nEntry USD estimate: $${position.entryUsd.toFixed(2)}`}\nNet sale proceeds so far: ${formatAmount(position.realizedNativeRaw, nativeDecimals[position.chain])} ${nativeSymbol[position.chain]}\nQuoted gain before sell network fees: ${position.lastProfitPercent === null ? 'Not refreshed' : `${position.lastProfitPercent.toFixed(2)}%`}${currentValue}\n\nFixed SL: ${onOff(exits.stopLoss.enabled)}${exits.stopLoss.lossPercent === null ? '' : ` (-${exits.stopLoss.lossPercent}%)`}\nTP stages: ${onOff(exits.takeProfitEnabled)}\n${exits.takeProfits.map((tier) => `+${tier.profitPercent}%: ${tier.sellPercent === 'rest' ? 'remaining' : `${tier.sellPercent}% of original`}`).join('\n')}\nTrailing SL: ${onOff(exits.trailingSl.enabled)}\nTrailing TP: ${onOff(exits.trailingTp.enabled)}${position.lastError ? `\n\nLast issue: ${position.lastError}` : ''}`,
      keyboard.text('Back', 'positions:0'),
    );
  }
  private async history(ctx: Context): Promise<void> {
    const operations = this.store.history();
    await this.display(
      ctx,
      `Recent trades\n\n${operations.map((operation) => `${operation.kind} ${label(operation.token.symbol)} (${operation.chain}): ${operation.status}\n${operation.swapHash ?? operation.id}${operation.error ? `\n${operation.error}` : ''}`).join('\n\n') || 'No trades yet.'}`,
      new InlineKeyboard().text('Back', 'home'),
    );
  }
  private async blocklist(ctx: Context): Promise<void> {
    const entries = this.store.settings().blockedCallers;
    await this.display(
      ctx,
      `Caller blocklist\n\n${entries.join('\n') || 'Empty'}\n\nUse a caller handle or their numeric channel ID. A matching block always overrides consistency.`,
      new InlineKeyboard()
        .text('Add callers', 'block:add')
        .text('Remove callers', 'block:remove')
        .row()
        .text('Back', 'home'),
    );
  }
  private updateChain(chain: Chain, action: (settings: ChainSettings) => void): void {
    this.store.updateSettings((settings) => {
      const updated = structuredClone(settings.chains[chain]);
      action(updated);
      settings.chains[chain] = chainSettingsSchema.parse(updated);
    });
  }
  private async callback(ctx: Context, data: string): Promise<void> {
    const [action, value, option] = data.split(':');
    if (action !== 'confirm') this.sale = null;
    this.pending = null;
    switch (action) {
      case 'home':
        await this.home(ctx);
        return;
      case 'chain':
        await this.chainMenu(ctx, chainValue(value));
        return;
      case 'menu':
        await this.group(ctx, chainValue(value), groupValue(option));
        return;
      case 'edit': {
        const chain = chainValue(value);
        const field = option ? editableFields[option] : undefined;
        if (!field || !option || (field.chains && !field.chains.includes(chain)))
          throw new Error('Unknown setting');
        this.pending = { kind: 'field', chain, field: option };
        await ctx.reply(
          `${field.label} (${nativeSymbol[chain]})\n\n${field.hint}\nSend /cancel to cancel.`,
        );
        return;
      }
      case 'toggle': {
        const chain = chainValue(value);
        const toggle = option ? toggles[option] : undefined;
        if (!toggle || (toggle.chains && !toggle.chains.includes(chain)))
          throw new Error('Unknown switch');
        this.updateChain(chain, toggle.change);
        await this.group(ctx, chain, toggle.group);
        return;
      }
      case 'enable': {
        const chain = chainValue(value);
        if (!this.store.settings().chains[chain].enabled) {
          const missing = this.engine.readiness(chain);
          if (missing.length) throw new Error(`Configure ${missing.join(', ')}`);
          await this.engine.adapters[chain].verifyNetwork();
        }
        this.updateChain(chain, (settings) => {
          settings.enabled = !settings.enabled;
        });
        await this.chainMenu(ctx, chain);
        return;
      }
      case 'addtp':
        this.pending = { kind: 'tp', chain: chainValue(value) };
        await ctx.reply(
          'Send: profit_percentage sell_percentage\nExample: 50 90 sells 90% of the original entry at +50%.\nExample: 1000 rest sells the remaining tokens at +1000%.\nThen enable Take profit stages.',
        );
        return;
      case 'deltp': {
        const chain = chainValue(value);
        this.updateChain(chain, (settings) => {
          settings.exits.takeProfits = settings.exits.takeProfits.filter(
            (tier) => tier.id !== option,
          );
          if (!settings.exits.takeProfits.length) settings.exits.takeProfitEnabled = false;
        });
        await this.group(ctx, chain, 'exits');
        return;
      }
      case 'wallets':
        await this.wallets(ctx);
        return;
      case 'positions':
        await this.positions(ctx, Number(value) || 0);
        return;
      case 'position':
        if (value) await this.position(ctx, value);
        return;
      case 'refresh':
        if (value) await this.position(ctx, value, true);
        return;
      case 'history':
        await this.history(ctx);
        return;
      case 'blocklist':
        await this.blocklist(ctx);
        return;
      case 'block':
        this.pending = { kind: 'block', remove: value === 'remove' };
        await ctx.reply(
          'Send caller handles or numeric channel IDs, separated by spaces or newlines. Send /cancel to cancel.',
        );
        return;
      case 'pause':
        this.engine.pause();
        await ctx.reply('New entries paused. Existing exits continue.');
        await this.home(ctx);
        return;
      case 'resume':
        await this.engine.resume();
        await this.home(ctx);
        return;
      case 'sell': {
        if (!value) return;
        const position = this.store.position(value);
        const percentage = Number(option);
        if (!position || ![25, 50, 100].includes(percentage)) throw new Error('Invalid sale');
        this.sale = {
          id: value,
          percentage,
          balance: position.remainingTokenRaw,
          expires: Date.now() + 120_000,
        };
        await this.display(
          ctx,
          `Sell ${percentage}% of the remaining ${label(position.symbol)} on ${position.chain}?\nSlippage and MEV settings for this chain apply.`,
          new InlineKeyboard()
            .text('Confirm sale', `confirm:${value}:${percentage}`)
            .row()
            .text('Cancel', `position:${value}`),
        );
        return;
      }
      case 'confirm': {
        const sale = this.sale;
        this.sale = null;
        if (
          !sale ||
          sale.id !== value ||
          sale.percentage !== Number(option) ||
          sale.expires < Date.now() ||
          this.store.position(sale.id)?.remainingTokenRaw !== sale.balance
        )
          throw new Error('Sale confirmation expired or holdings changed. Select the sale again.');
        await this.engine.sell(sale.id, sale.percentage);
        await ctx.reply('Sale queued. Confirmation will be reported here.');
        await this.position(ctx, sale.id);
        return;
      }
      case 'apply': {
        if (!value) return;
        const position = this.store.position(value);
        if (!position || position.closedAt !== null) throw new Error('No open position');
        await this.display(
          ctx,
          `Replace ${label(position.symbol)} exit rules with the current ${position.chain} exit settings? Existing trailing peaks will reset.`,
          new InlineKeyboard()
            .text('Apply exit settings', `applyyes:${value}`)
            .row()
            .text('Cancel', `position:${value}`),
        );
        return;
      }
      case 'applyyes': {
        if (!value) return;
        const position = this.store.position(value);
        if (!position || position.closedAt !== null || this.store.activeOperation(position.chain))
          throw new Error('Position is unavailable or has an active operation');
        position.exits = structuredClone(this.store.settings().chains[position.chain].exits);
        position.trailingSl = emptyTrail();
        position.trailingTp = emptyTrail();
        this.store.savePosition(position);
        await this.position(ctx, value);
        return;
      }
      case 'unwrap':
        await this.display(
          ctx,
          'Unwrap all idle Robinhood WETH into ETH? Network fees apply. Active trades must finish first.',
          new InlineKeyboard().text('Confirm unwrap', 'unwrapyes').row().text('Cancel', 'wallets'),
        );
        return;
      case 'unwrapyes':
        await this.engine.unwrap();
        await ctx.reply('Unwrap queued.');
        return;
      case 'reconcile':
        if (value) this.engine.reconcile(value);
        await this.home(ctx);
        return;
      case 'recent':
        await this.display(
          ctx,
          `Recent calls\n\n${
            this.store
              .signalHistory()
              .map(
                (signal) =>
                  `${signal.id}: ${signal.state}${signal.reason ? `\n${signal.reason}` : ''}`,
              )
              .join('\n\n') || 'No calls received yet.'
          }`,
          new InlineKeyboard().text('Back', 'home'),
        );
        return;
      default:
        throw new Error('This menu action is no longer available');
    }
  }
  private async text(ctx: Context, text: string): Promise<void> {
    const pending = this.pending;
    if (!pending) {
      await ctx.reply('Use /settings to choose a setting to edit.');
      return;
    }
    if (pending.kind === 'field') {
      const updated = applyField(
        this.store.settings().chains[pending.chain],
        pending.chain,
        pending.field,
        text,
      );
      this.store.updateSettings((settings) => {
        settings.chains[pending.chain] = updated;
      });
      this.pending = null;
      await ctx.reply('Setting saved.');
      await this.group(ctx, pending.chain, editableFields[pending.field]!.group);
      return;
    }
    if (pending.kind === 'tp') {
      const [profitValue, saleValue, extra] = text.trim().split(/\s+/);
      if (
        !profitValue ||
        !saleValue ||
        extra ||
        !/^\d+(?:\.\d+)?$/.test(profitValue) ||
        (saleValue !== 'rest' && !/^\d+(?:\.\d+)?$/.test(saleValue))
      )
        throw new Error('Send two values, for example: 50 90 or 1000 rest');
      const profit = Number(profitValue);
      if (profit > 1_000_000) throw new Error('Profit target is too large');
      this.updateChain(pending.chain, (settings) => {
        settings.exits.takeProfits.push({
          id: this.store.newId(),
          profitPercent: profit,
          sellPercent: saleValue === 'rest' ? 'rest' : Number(saleValue),
        });
      });
      this.pending = null;
      await ctx.reply('TP stage saved. Enable Take profit stages when the plan is ready.');
      await this.group(ctx, pending.chain, 'exits');
      return;
    }
    const callers = text
      .toLowerCase()
      .trim()
      .split(/[\s,]+/)
      .map((value) => value.replace(/^@/, ''));
    if (!callers.length || callers.some((value) => !/^(?:[a-z][a-z0-9_]{3,}|-?\d+)$/.test(value)))
      throw new Error('Use valid caller handles or numeric channel IDs');
    this.store.updateSettings((settings) => {
      settings.blockedCallers = pending.remove
        ? settings.blockedCallers.filter((caller) => !callers.includes(caller.replace(/^@/, '')))
        : [...new Set([...settings.blockedCallers, ...callers])];
    });
    this.pending = null;
    await this.blocklist(ctx);
  }
  async start(): Promise<void> {
    await this.bot.init();
    await this.bot.api.setMyCommands([
      { command: 'settings', description: 'Configure trading and filters' },
      { command: 'wallets', description: 'Wallet addresses and balances' },
      { command: 'positions', description: 'Positions, profit and manual sales' },
      { command: 'history', description: 'Trade history' },
      { command: 'pause', description: 'Pause new entries; exits continue' },
      { command: 'resume', description: 'Enable configured entries' },
      { command: 'help', description: 'Usage and percentage rules' },
      { command: 'cancel', description: 'Cancel the current input' },
    ]);
    this.notifier = setInterval(() => {
      void this.flushNotifications();
    }, 1500);
    void this.bot.start({ allowed_updates: ['message', 'callback_query'] }).catch((error) => {
      console.error(JSON.stringify({ event: 'telegram_polling_error', message: safeError(error) }));
      this.engine.pause();
    });
  }
  private async flushNotifications(): Promise<void> {
    if (this.sending || Date.now() < this.notificationCooldown) return;
    this.sending = true;
    try {
      for (const notification of this.store.notifications()) {
        await this.bot.api.sendMessage(this.config.ownerId, notification.text.slice(0, 3900), {
          link_preview_options: { is_disabled: true },
        });
        this.store.delivered(notification.id);
        await delay(1200);
      }
    } catch {
      this.notificationCooldown = Date.now() + 30_000;
    } finally {
      this.sending = false;
    }
  }
  async stop(): Promise<void> {
    if (this.notifier) clearInterval(this.notifier);
    if (this.bot.isRunning()) await this.bot.stop();
    while (this.sending) await delay(100);
  }
}
