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
import { randomUUID } from 'node:crypto';
import { logger, withLogContext } from '../logging/logger.js';
import { recentCallMessage } from './call-history.js';
import {
  bold,
  italic,
  code,
  message,
  joinMessages,
  renderMessage,
  notificationMessage,
  type MessageText,
} from './presentation.js';

const log = logger.child({ component: 'telegram.control' });
const apiLog = logger.child({ component: 'api.telegram', service: 'Telegram Bot API' });

type PendingInput =
  | { kind: 'field'; chain: Chain; field: string }
  | { kind: 'tp'; chain: Chain }
  | { kind: 'block'; remove: boolean };
const label = (value: string): string => value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 60);
const onOff = (value: boolean): string => (value ? '✅ On' : '⚪ Off');
const chainName = (chain: Chain): string =>
  chain === 'solana' ? '🟣 Solana (SOL)' : '🟢 Robinhood (ETH)';
const statuses: Record<string, string> = {
  active: '⏳ Pending',
  confirmed: '✅ Confirmed',
  review: '⚠️ Review needed',
  failed: '❌ Failed',
  pending: '⏳ Pending',
  skipped: '⏭️ Skipped',
  claimed: '🔒 Claimed',
};
const statusLabel = (status: string): string => statuses[status] ?? status;
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
    private readonly hydrateHistory?: (messageIds: number[]) => Promise<void>,
  ) {
    this.bot = new Bot(config.botToken);
    this.bot.api.config.use(async (prev, method, payload, signal) => {
      const fields = { apiMethod: method, requestId: randomUUID() };
      const started = Date.now();
      apiLog.debug('api.request', fields);
      try {
        const response = await prev(method, payload, signal);
        if (!response.ok)
          apiLog.error('api.telegram_failed', response, {
            ...fields,
            durationMs: Date.now() - started,
          });
        else
          apiLog.debug('api.response', {
            ...fields,
            durationMs: Date.now() - started,
            updateCount:
              method === 'getUpdates' && Array.isArray(response.result)
                ? response.result.length
                : undefined,
          });
        return response;
      } catch (error) {
        apiLog.error('api.telegram_failed', error, { ...fields, durationMs: Date.now() - started });
        throw error;
      }
    });
    this.bot.use(async (ctx, next) => {
      if (ctx.from?.id === config.ownerId && ctx.chat?.type === 'private') {
        await withLogContext({ updateId: ctx.update.update_id }, async () => {
          log.debug('control.update_received', {
            action:
              ctx.callbackQuery?.data ??
              ctx.message?.text?.split(/\s/)[0]?.replace(/^[^/].*$/, 'setting_input'),
          });
          await next();
          log.debug('control.update_handled');
        });
      } else log.warn('control.access_denied', { userId: ctx.from?.id, chatType: ctx.chat?.type });
    });
    this.bot.command(['start', 'settings'], (ctx) => this.home(ctx));
    this.bot.command('wallets', (ctx) => this.wallets(ctx));
    this.bot.command('positions', (ctx) => this.positions(ctx, 0));
    this.bot.command('history', (ctx) => this.history(ctx));
    this.bot.command('cancel', async (ctx) => {
      this.pending = null;
      this.sale = null;
      await this.home(ctx);
    });
    this.bot.command('help', (ctx) =>
      this.reply(
        ctx,
        joinMessages([
          message`📖 ${bold('Tracker guide')}`,
          '',
          '⚙️ /settings · Trading, filters and exits',
          '👛 /wallets · Addresses and balances',
          '📊 /positions · Inspect positions or sell',
          '📜 /history · Recent trades',
          '✖️ /cancel · Cancel the current input',
          '',
          message`💰 ${bold('Before enabling a chain')}`,
          'Set buy size and slippage. Priority fees are automatic unless you set an override. All three consistency thresholds start at 30%. Entry filters and exits start disabled.',
          'Enable a chain to buy matching calls automatically. Disable it to stop new buys; configured exits for existing positions continue.',
          '',
          message`🎯 ${bold('Profit and sell percentages')}`,
          'Profit uses fresh SOL/ETH quotes against entry spending, including recorded entry fees. Confirmed proceeds include sell network fees; fills follow your slippage setting.',
          message`Fixed TP: percentage of the ${bold('original entry')}.`,
          message`Trailing TP: percentage of the ${bold('remaining balance')}.`,
          '',
          italic(
            'Settings apply to future positions. Use Apply current exit settings to update an open position. Wallet withdrawal and private-key export are unavailable.',
          ),
          ...(this.config.listenOnly
            ? [
                '',
                message`👀 ${bold('Listen only is active')}\nAll trading and automatic exits are blocked until LISTEN_ONLY is disabled and the app is restarted.`,
              ]
            : []),
        ]),
      ),
    );
    this.bot.on('callback_query:data', async (ctx) => {
      try {
        await ctx.answerCallbackQuery();
        await this.callback(ctx, ctx.callbackQuery.data);
      } catch (error) {
        log.error('control.callback_failed', error, { action: ctx.callbackQuery.data });
        await this.reply(
          ctx,
          message`⚠️ ${bold('Action could not be completed')}\n${safeError(error)}`,
        );
      }
    });
    this.bot.on('message:text', async (ctx) => {
      try {
        await this.text(ctx, ctx.message.text);
      } catch (error) {
        log.error('control.input_failed', error, { inputKind: this.pending?.kind });
        await this.reply(ctx, message`⚠️ ${bold('Setting not saved')}\n${safeError(error)}`);
      }
    });
    this.bot.catch((error) => {
      log.error('control.handler_failed', error.error, { updateId: error.ctx.update.update_id });
    });
  }
  private async reply(ctx: Context, text: string | MessageText): Promise<void> {
    const rendered = renderMessage(text);
    await ctx.reply(rendered.text, {
      entities: rendered.entities,
      link_preview_options: { is_disabled: true },
    });
  }
  private async display(
    ctx: Context,
    text: string | MessageText,
    keyboard: InlineKeyboard,
  ): Promise<void> {
    const rendered = renderMessage(text);
    const options = {
      entities: rendered.entities,
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    };
    if (ctx.callbackQuery?.message) {
      try {
        await ctx.editMessageText(rendered.text, options);
        return;
      } catch (error) {
        if (safeError(error).includes('message is not modified')) return;
        log.error('control.edit_failed', error, { fallback: 'send_new_message' });
      }
    }
    await ctx.reply(rendered.text, options);
  }
  private async home(ctx: Context): Promise<void> {
    this.pending = null;
    const settings = this.store.settings();
    const reader = this.store.metadata('reader:last-success');
    const pending = chains
      .map((chain) => this.store.activeOperation(chain))
      .filter((operation) => operation !== null);
    const text = joinMessages([
      message`🔎 ${bold('SpyDefi tracker')}`,
      '',
      ...(this.config.listenOnly
        ? [
            message`👀 ${bold('LISTEN ONLY')}`,
            italic('Listening to calls. All buys, sells and automatic exits are blocked.'),
            '',
          ]
        : []),
      message`📡 ${bold('Source:')} @${this.config.sourceChannel}`,
      message`🕒 ${bold('Reader checked:')} ${reader ? new Date(Number(reader)).toISOString() : 'Connecting…'}`,
      message`📊 ${bold('Open positions:')} ${this.store.positions().length}`,
      '',
      ...chains.flatMap((chain) => [
        bold(chainName(chain)),
        message`Entries: ${onOff(settings.chains[chain].enabled)} · Buy size: ${settings.chains[chain].buySizeNative ?? 'Unset'} ${nativeSymbol[chain]}`,
      ]),
      ...(pending.length
        ? [
            '',
            message`⏳ ${bold('Active operations')}`,
            ...pending.map(
              (operation) =>
                message`${chainName(operation.chain)} · ${statusLabel(operation.status)}\n${operation.error ?? operation.kind}`,
            ),
          ]
        : []),
    ]);
    const keyboard = new InlineKeyboard()
      .text('🟣 Solana settings', 'chain:solana')
      .text('🟢 Robinhood settings', 'chain:robinhood')
      .row()
      .text('👛 Wallets', 'wallets')
      .text('📊 Positions', 'positions:0')
      .row()
      .text('🚫 Caller blocklist', 'blocklist')
      .text('📜 History', 'history')
      .row()
      .text('📞 Recent calls', 'recent');
    for (const operation of pending)
      if (operation.status === 'review')
        keyboard.row().text(`🔄 Reconcile ${operation.chain}`, `reconcile:${operation.id}`);
    await this.display(ctx, text, keyboard);
  }
  private async chainMenu(ctx: Context, chain: Chain): Promise<void> {
    const settings = this.store.settings().chains[chain];
    const missing = this.engine.readiness(chain);
    const text = joinMessages([
      bold(`${chainName(chain)} settings`),
      '',
      message`⚙️ ${bold('Chain entries:')} ${onOff(settings.enabled)}`,
      message`💰 ${bold('Buy size:')} ${settings.buySizeNative ?? 'Unset'} ${nativeSymbol[chain]}`,
      '',
      message`🎯 ${bold('Minimum consistency')}`,
      `Overall: ${settings.consistency.overall}% · Recent: ${settings.consistency.recent}% · Chain: ${settings.consistency.chain}%`,
      '',
      missing.length
        ? message`📝 ${bold('Still needed:')} ${missing.join(', ')}`
        : settings.enabled
          ? this.config.listenOnly
            ? message`👀 ${bold('Chain enabled. Listen-only mode blocks trading.')}`
            : message`✅ ${bold('Enabled: matching calls are bought automatically.')}`
          : message`✅ ${bold('Ready to enable entries.')}`,
      ...(this.config.listenOnly ? [message`👀 ${bold('Listen only: trading is blocked.')}`] : []),
      '',
      italic(
        'Market cap and token safety are under Entry filters. Configure and enable exits before using them.',
      ),
    ]);
    const keyboard = new InlineKeyboard()
      .text('💰 Buy size', `menu:${chain}:buy`)
      .text('🎯 Consistency', `menu:${chain}:consistency`)
      .row()
      .text('🛡️ Entry filters', `menu:${chain}:filters`)
      .text('📈 SL / TP / trailing', `menu:${chain}:exits`)
      .row()
      .text('⛽ Slippage / fees / MEV', `menu:${chain}:execution`)
      .row()
      .text(
        settings.enabled ? '⏸️ Disable chain entries' : '▶️ Enable chain entries',
        `enable:${chain}`,
      )
      .row()
      .text('⬅️ Back', 'home');
    await this.display(ctx, text, keyboard);
  }
  private async group(ctx: Context, chain: Chain, group: EditableField['group']): Promise<void> {
    const settings = this.store.settings().chains[chain];
    const keyboard = new InlineKeyboard();
    const title = {
      buy: '💰 Buy size',
      consistency: '🎯 Consistency thresholds',
      filters: '🛡️ Entry filters: market cap and token safety',
      exits: '📈 Stop loss, take profit and trailing',
      execution: '⚡ Slippage, priority fees and MEV protection',
    }[group];
    const lines: (string | MessageText)[] = [bold(title), chainName(chain), ''];
    for (const [key, field] of Object.entries(editableFields)) {
      if (field.group !== group || (field.chains && !field.chains.includes(chain))) continue;
      const value = field.value(settings);
      lines.push(message`${bold(`${field.label}:`)} ${value ?? field.emptyLabel ?? 'Unset'}`);
      keyboard.text(field.label, `edit:${chain}:${key}`).row();
    }
    for (const [key, toggle] of Object.entries(toggles)) {
      if (toggle.group !== group || (toggle.chains && !toggle.chains.includes(chain))) continue;
      lines.push(message`${bold(`${toggle.label}:`)} ${onOff(toggle.value(settings))}`);
      keyboard
        .text(`${toggle.label}: ${onOff(toggle.value(settings))}`, `toggle:${chain}:${key}`)
        .row();
    }
    if (group === 'exits') {
      lines.push(
        '',
        message`🎯 ${bold('Fixed TP stages')}`,
        italic('Sell percentages refer to the original entry.'),
      );
      for (const tier of [...settings.exits.takeProfits].sort(
        (a, b) => a.profitPercent - b.profitPercent,
      )) {
        lines.push(
          message`${bold(`+${tier.profitPercent}% profit:`)} ${tier.sellPercent === 'rest' ? 'sell remaining' : `sell ${tier.sellPercent}%`}`,
        );
        keyboard.text(`🗑️ Remove +${tier.profitPercent}% TP`, `deltp:${chain}:${tier.id}`).row();
      }
      keyboard.text('➕ Add TP stage', `addtp:${chain}`).row();
      lines.push(
        '',
        italic(
          'Set values, then enable the desired exits. Trailing activates at its profit threshold and can sell before a later fixed TP. Changes apply to new positions; open positions have a separate apply action.',
        ),
      );
    }
    if (group === 'filters')
      lines.push(
        '',
        italic(
          'MC uses current data at buy time. Missing data rejects the buy while a corresponding check is enabled. Optional numeric limits activate when set; send off to remove them.',
        ),
      );
    if (group === 'execution')
      lines.push(
        '',
        italic(
          chain === 'solana'
            ? 'Jupiter builds and submits Solana buys and sells through its managed execution service. QuickNode reads receipts and reconciles pending trades. QuickNode dashboard MEV settings do not apply to Jupiter submissions.'
            : 'Protected swaps require a UniswapX route. ETH is wrapped for the buy, and sale proceeds are unwrapped back to ETH. No public AMM fallback while protection is on.',
        ),
      );
    await this.display(ctx, joinMessages(lines), keyboard.text('⬅️ Back', `chain:${chain}`));
  }
  private async wallets(ctx: Context): Promise<void> {
    const lines: (string | MessageText)[] = [
      message`👛 ${bold('Trading wallets')}`,
      '',
      italic(
        'Generated locally on first startup and reused on subsequent starts. Tap an address to copy it.',
      ),
      '',
    ];
    for (const chain of chains) {
      lines.push(bold(chainName(chain)), code(this.engine.adapters[chain].address));
      try {
        const balance = await this.engine.adapters[chain].balance();
        lines.push(
          message`💰 ${bold('Balance:')} ${formatAmount(balance.nativeRaw, nativeDecimals[chain])} ${nativeSymbol[chain]}`,
        );
        if (balance.wrappedRaw !== null)
          lines.push(
            message`🔄 ${bold('Wrapped balance:')} ${formatAmount(balance.wrappedRaw, 18)} WETH`,
          );
      } catch (error) {
        log.error('control.balance_failed', error, { chain });
        lines.push(message`⚠️ ${bold('Balance unavailable:')} ${safeError(error)}`);
      }
      lines.push('');
    }
    await this.display(
      ctx,
      joinMessages(lines),
      new InlineKeyboard()
        .text('🔄 Unwrap idle Robinhood WETH', 'unwrap')
        .row()
        .text('🔄 Refresh', 'wallets')
        .text('⬅️ Back', 'home'),
    );
  }
  private async positions(ctx: Context, page: number): Promise<void> {
    const positions = this.store.positions();
    const start = Math.max(0, page) * 5;
    const visible = positions.slice(start, start + 5);
    const keyboard = new InlineKeyboard();
    const lines: (string | MessageText)[] = [message`📊 ${bold('Open positions')}`, ''];
    for (const position of visible) {
      lines.push(
        bold(`${label(position.symbol)} (${nativeSymbol[position.chain]})`),
        `${formatAmount(position.remainingTokenRaw, position.decimals)} tokens | ${position.lastProfitPercent === null ? 'Value not refreshed' : `${position.lastProfitPercent.toFixed(2)}% in ${nativeSymbol[position.chain]}`}`,
        '',
      );
      keyboard.text(`⚙️ ${label(position.symbol)} · Manage`, `position:${position.id}`).row();
    }
    if (positions.length === 0) lines.push(italic('No open positions yet.'));
    if (page > 0) keyboard.text('⬅️ Previous', `positions:${page - 1}`);
    if (start + 5 < positions.length) keyboard.text('Next ➡️', `positions:${page + 1}`);
    await this.display(ctx, joinMessages(lines), keyboard.row().text('⬅️ Back', 'home'));
  }
  private async position(ctx: Context, id: string, refresh = false): Promise<void> {
    let position = this.store.position(id);
    if (!position) throw new Error('Position not found');
    if (refresh && position.closedAt === null) position = await this.engine.refresh(position);
    const keyboard = new InlineKeyboard().text('🔄 Refresh value', `refresh:${id}`).row();
    if (position.closedAt === null)
      keyboard
        .text('💸 Sell 25%', `sell:${id}:25`)
        .text('💸 Sell 50%', `sell:${id}:50`)
        .text('💸 Sell all', `sell:${id}:100`)
        .row()
        .text('⚙️ Apply current exit settings', `apply:${id}`)
        .row();
    const exits = position.exits;
    const currentValue =
      position.lastValueNativeRaw === null
        ? ''
        : message`💰 ${bold('Quoted remaining value:')} ${formatAmount(position.lastValueNativeRaw, nativeDecimals[position.chain])} ${nativeSymbol[position.chain]}${position.lastValueUsd === null ? '' : ` (approximately $${position.lastValueUsd.toFixed(2)})`}`;
    await this.display(
      ctx,
      joinMessages([
        message`📊 ${bold(`${label(position.symbol)} (${nativeSymbol[position.chain]})`)}`,
        code(position.address),
        '',
        message`🪙 ${bold('Remaining:')} ${formatAmount(position.remainingTokenRaw, position.decimals)} tokens`,
        message`💳 ${bold('Entry spending:')} ${formatAmount(position.entryNativeRaw, nativeDecimals[position.chain])} ${nativeSymbol[position.chain]}`,
        ...(position.entryUsd === null
          ? []
          : [message`💵 ${bold('Entry USD estimate:')} $${position.entryUsd.toFixed(2)}`]),
        message`💸 ${bold('Net sale proceeds so far:')} ${formatAmount(position.realizedNativeRaw, nativeDecimals[position.chain])} ${nativeSymbol[position.chain]}`,
        message`📈 ${bold('Quoted gain:')} ${position.lastProfitPercent === null ? 'Not refreshed' : `${position.lastProfitPercent.toFixed(2)}%`}`,
        italic('Quoted gain is before sell network fees.'),
        ...(currentValue ? [currentValue] : []),
        '',
        message`🛑 ${bold('Fixed SL:')} ${onOff(exits.stopLoss.enabled)}${exits.stopLoss.lossPercent === null ? '' : ` (-${exits.stopLoss.lossPercent}%)`}`,
        message`🎯 ${bold('TP stages:')} ${onOff(exits.takeProfitEnabled)}`,
        ...exits.takeProfits.map(
          (tier) =>
            message`${bold(`+${tier.profitPercent}%:`)} ${tier.sellPercent === 'rest' ? 'sell remaining' : `sell ${tier.sellPercent}% of original`}`,
        ),
        message`📉 ${bold('Trailing SL:')} ${onOff(exits.trailingSl.enabled)}`,
        message`📈 ${bold('Trailing TP:')} ${onOff(exits.trailingTp.enabled)}`,
        ...(position.lastError
          ? ['', message`⚠️ ${bold('Last issue')}\n${position.lastError}`]
          : []),
      ]),
      keyboard.text('⬅️ Back', 'positions:0'),
    );
  }
  private async history(ctx: Context): Promise<void> {
    const operations = this.store.history();
    await this.display(
      ctx,
      joinMessages([
        message`📜 ${bold('Recent trades')}`,
        '',
        operations.length
          ? joinMessages(
              operations.map((operation) =>
                joinMessages([
                  bold(
                    `${operation.kind.toUpperCase()} ${label(operation.token.symbol)} (${nativeSymbol[operation.chain]})`,
                  ),
                  statusLabel(operation.status),
                  code(operation.swapHash ?? operation.id),
                  ...(operation.error ? [message`⚠️ ${operation.error}`] : []),
                ]),
              ),
              '\n\n',
            )
          : italic('No trades yet.'),
      ]),
      new InlineKeyboard().text('⬅️ Back', 'home'),
    );
  }
  private async blocklist(ctx: Context): Promise<void> {
    const entries = this.store.settings().blockedCallers;
    await this.display(
      ctx,
      joinMessages([
        message`🚫 ${bold('Caller blocklist')}`,
        '',
        entries.length
          ? joinMessages(entries.map((entry) => code(entry)))
          : italic('Your blocklist is empty.'),
        '',
        italic(
          'Use a caller handle or their numeric channel ID. Blocked callers are always skipped, regardless of consistency.',
        ),
      ]),
      new InlineKeyboard()
        .text('➕ Add callers', 'block:add')
        .text('➖ Remove callers', 'block:remove')
        .row()
        .text('⬅️ Back', 'home'),
    );
  }
  private async recent(ctx: Context, requestedPage: number): Promise<void> {
    let calls = this.store.signalHistory();
    const pageSize = 3;
    const initialPage = Math.min(
      Math.max(0, Math.floor(requestedPage)),
      Math.max(0, Math.ceil(calls.length / pageSize) - 1),
    );
    const missing = calls
      .slice(initialPage * pageSize, (initialPage + 1) * pageSize)
      .filter((call) => call.post === null);
    if (missing.length && this.hydrateHistory) {
      try {
        await this.hydrateHistory(missing.map((call) => call.messageId));
        calls = this.store.signalHistory();
      } catch (error) {
        log.error('control.call_details_failed', error, {
          messageIds: missing.map((call) => call.messageId),
        });
      }
    }
    const pages = Math.max(1, Math.ceil(calls.length / pageSize));
    const page = Math.min(initialPage, pages - 1);
    const visible = calls.slice(page * pageSize, (page + 1) * pageSize);
    const keyboard = new InlineKeyboard();
    if (page > 0) keyboard.text('⬅️ Previous', `recent:${page - 1}`);
    if (page + 1 < pages) keyboard.text('Next ➡️', `recent:${page + 1}`);
    keyboard.row().text('🔄 Refresh', `recent:${page}`).text('⬅️ Back', 'home');
    await this.display(
      ctx,
      joinMessages([
        message`📞 ${bold('Recent calls')}`,
        italic(`Page ${page + 1} of ${pages} · Latest ${calls.length} posts`),
        '',
        visible.length
          ? joinMessages(
              visible.map((call) =>
                recentCallMessage(call, this.config.sourceChannel, this.config.listenOnly),
              ),
              '\n\n',
            )
          : italic('No calls received yet. Waiting for a new channel post.'),
        ...(visible.some((call) => call.state === 'pending' && !call.observation)
          ? ['', italic('Older captured calls may not have a saved filter decision.')]
          : []),
      ]),
      keyboard,
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
        await this.reply(
          ctx,
          message`${bold(`${field.label} (${nativeSymbol[chain]})`)}\n\n${field.hint}\n\n${italic('Send /cancel to cancel.')}`,
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
        void this.engine
          .tick()
          .catch((error) => log.error('control.chain_tick_failed', error, { chain }));
        await this.chainMenu(ctx, chain);
        return;
      }
      case 'addtp':
        this.pending = { kind: 'tp', chain: chainValue(value) };
        await this.reply(
          ctx,
          joinMessages([
            message`🎯 ${bold('Add a take-profit stage')}`,
            '',
            'Send the profit target and sell percentage:',
            code('profit_percentage sell_percentage'),
            '',
            message`${code('50 90')} · Sell 90% of the original entry at +50%.`,
            message`${code('1000 rest')} · Sell the remaining tokens at +1000%.`,
            '',
            italic('Enable Take profit stages when your plan is ready. Send /cancel to cancel.'),
          ]),
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
        await this.reply(
          ctx,
          message`🚫 ${bold(value === 'remove' ? 'Remove blocked callers' : 'Block callers')}\n\nSend caller handles or numeric channel IDs, separated by spaces or newlines.\n\n${italic('Send /cancel to cancel.')}`,
        );
        return;
      case 'pause':
      case 'resume':
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
          message`💸 ${bold('Confirm sale')}\n\nSell ${bold(`${percentage}%`)} of the remaining ${bold(label(position.symbol))} on ${chainName(position.chain)}?\n\n${italic('Slippage and MEV settings for this chain apply.')}`,
          new InlineKeyboard()
            .text('✅ Confirm sale', `confirm:${value}:${percentage}`)
            .row()
            .text('✖️ Cancel', `position:${value}`),
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
        await this.reply(
          ctx,
          message`⏳ ${bold('Sale queued')}\n${italic('Confirmation will be reported here.')}`,
        );
        await this.position(ctx, sale.id);
        return;
      }
      case 'apply': {
        if (!value) return;
        const position = this.store.position(value);
        if (!position || position.closedAt !== null) throw new Error('No open position');
        await this.display(
          ctx,
          message`⚙️ ${bold('Apply current exit settings?')}\n\nReplace the exit rules for ${bold(label(position.symbol))} with your current ${nativeSymbol[position.chain]} settings?\n\n⚠️ ${italic('Existing trailing peaks will reset.')}`,
          new InlineKeyboard()
            .text('✅ Apply exit settings', `applyyes:${value}`)
            .row()
            .text('✖️ Cancel', `position:${value}`),
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
          message`🔄 ${bold('Unwrap idle WETH?')}\n\nConvert all idle Robinhood WETH into ETH.\n\n${italic('Network fees apply. Active trades must finish first.')}`,
          new InlineKeyboard()
            .text('✅ Confirm unwrap', 'unwrapyes')
            .row()
            .text('✖️ Cancel', 'wallets'),
        );
        return;
      case 'unwrapyes':
        await this.engine.unwrap();
        await this.reply(
          ctx,
          message`⏳ ${bold('Unwrap queued')}\n${italic('Confirmation will be reported here.')}`,
        );
        return;
      case 'reconcile':
        if (value) this.engine.reconcile(value);
        await this.home(ctx);
        return;
      case 'recent':
        await this.recent(ctx, Number(value) || 0);
        return;
      default:
        throw new Error('This menu action is no longer available');
    }
  }
  private async text(ctx: Context, text: string): Promise<void> {
    const pending = this.pending;
    if (!pending) {
      await this.reply(ctx, message`⚙️ Use /settings to choose a setting to edit.`);
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
      await this.reply(ctx, message`✅ ${bold('Setting saved')}`);
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
      await this.reply(
        ctx,
        message`✅ ${bold('TP stage saved')}\n${italic('Enable Take profit stages when your plan is ready.')}`,
      );
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
      { command: 'settings', description: '⚙️ Configure trading and filters' },
      { command: 'wallets', description: '👛 Wallet addresses and balances' },
      { command: 'positions', description: '📊 Positions, profit and manual sales' },
      { command: 'history', description: '📜 Trade history' },
      { command: 'help', description: '📖 Usage and percentage rules' },
      { command: 'cancel', description: '✖️ Cancel the current input' },
    ]);
    this.notifier = setInterval(() => {
      void this.flushNotifications();
    }, 1500);
    void this.bot.start({ allowed_updates: ['message', 'callback_query'] }).catch((error) => {
      log.error('control.polling_failed', error);
      this.store.updateSettings((settings) => {
        for (const chain of chains) settings.chains[chain].enabled = false;
      });
      log.warn('chain.entries_disabled', { chains, reason: 'telegram_control_polling_failed' });
    });
    log.debug('control.started', {
      ownerId: this.config.ownerId,
      listenOnly: this.config.listenOnly,
    });
  }
  private async flushNotifications(): Promise<void> {
    if (this.sending || Date.now() < this.notificationCooldown) return;
    this.sending = true;
    try {
      for (const notification of this.store.notifications()) {
        log.debug('notification.sending', { notificationId: notification.id });
        const rendered = renderMessage(notificationMessage(notification.text));
        await this.bot.api.sendMessage(this.config.ownerId, rendered.text, {
          entities: rendered.entities,
          link_preview_options: { is_disabled: true },
        });
        this.store.delivered(notification.id);
        log.debug('notification.delivered', { notificationId: notification.id });
        await delay(1200);
      }
    } catch (error) {
      this.notificationCooldown = Date.now() + 30_000;
      log.error('notification.failed', error, {
        retryAt: new Date(this.notificationCooldown).toISOString(),
      });
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
