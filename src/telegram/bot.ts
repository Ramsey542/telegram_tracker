import { Bot, InlineKeyboard, type Context } from 'grammy';
import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from '../config.js';
import {
  chains,
  emptyTrail,
  formatAmount,
  nativeDecimals,
  nativeSymbol,
  type Chain,
  type ChainSettings,
  type CallChannel,
} from '../domain.js';
import { Store } from '../infra/store.js';
import { safeError } from '../infra/http.js';
import { TradeEngine } from '../trading/engine.js';
import { withdrawalAddress, withdrawalAmount } from '../trading/withdrawal.js';
import { applyField, editableFields, toggles, type EditableField } from './settings.js';
import {
  exitKind,
  exitMode,
  selectedMode,
  exitEnabled,
  exitReady,
  setExitEnabled,
  setExitMode,
  saveHardExit,
  saveTrailingStage,
  removeTrailingStage,
  exitSummary,
  exitPlanLines,
  exitPanel,
  exitPrompt,
  settingsError,
  type ExitKind,
  type ExitMode,
} from './exits.js';
import { telegramTiming, telegramApiLogging } from './control-api.js';
import {
  BotAccess,
  watcherCallbackAllowed,
  watcherCommandAllowed,
  watcherKeyboard,
} from './access.js';
import { logger, withLogContext } from '../logging/logger.js';
import { recentCallMessage } from './call-history.js';
import { channelDetails, channelList, channelStatus } from './channels.js';
import type { ChannelRegistry } from './channel-registry.js';
import {
  settingsAction,
  settingsCallback,
  settingsKeyboard,
  unpackSettingsCallback,
} from './settings-scope.js';
import { positionEntryPrice, positionPage } from './positions.js';
import type { Position } from '../domain.js';
import { pnlChain, pnlMessage, pnlPeriod } from './pnl.js';
import { pnlWindow } from '../pnl/periods.js';
import { summarizePnl } from '../pnl/accounting.js';
import type { PnlChain, PnlPeriod } from '../pnl/types.js';
import type { PnlTracker } from '../pnl/tracker.js';
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

type PendingInput =
  | { kind: 'field'; chain: Chain; field: string; sourceId?: string }
  | {
      kind: 'exit';
      chain: Chain;
      target: ExitKind;
      mode: ExitMode;
      enableAfter: boolean;
      append: boolean;
      sourceId?: string;
    }
  | { kind: 'block'; remove: boolean; sourceId?: string }
  | { kind: 'channel_add' }
  | { kind: 'wrap_amount'; sourceId?: string }
  | { kind: 'withdraw_address'; chain: Chain }
  | { kind: 'withdraw_amount'; chain: Chain; recipient: string };
interface InteractionState {
  wrapping?: { id: string; amount: string; expires: number; sourceId?: string };
  settingsSourceId: string | null;
  pending: PendingInput | null;
  sale: { id: string; percentage: number; balance: string; expires: number } | null;
  withdrawal: {
    id: string;
    chain: Chain;
    recipient: string;
    amount: string;
    expires: number;
  } | null;
}
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
  private readonly interactions = new Map<number, InteractionState>();
  private readonly viewVersions = new Map<number, number>();
  private readonly positionQuotes = new Map<string, Promise<Position>>();
  private readonly refreshTasks = new Set<Promise<void>>();
  private notifier: ReturnType<typeof setInterval> | null = null;
  private readonly sending = new Set<number>();
  private readonly notificationCooldown = new Map<number, number>();
  private readonly access: BotAccess;
  private stopping = false;
  private readonly pollingTimeoutSeconds: number;
  constructor(
    private readonly config: Config,
    private readonly store: Store,
    private readonly engine: TradeEngine,
    private readonly hydrateHistory?: (
      references: { channelId: string; messageId: number }[],
    ) => Promise<void>,
    private readonly pnlTracker?: PnlTracker,
    private readonly channelRegistry?: ChannelRegistry,
  ) {
    this.access = new BotAccess(config.ownerId, config.watcherUsername ?? '', store);
    const timing = telegramTiming(config.httpTimeoutMs);
    this.pollingTimeoutSeconds = timing.pollingTimeoutSeconds;
    this.bot = new Bot(config.botToken, {
      client: { timeoutSeconds: timing.requestTimeoutSeconds },
    });
    this.bot.api.config.use(telegramApiLogging(config.httpTimeoutMs, () => this.stopping));
    this.bot.use(async (ctx, next) => {
      const previousWatcher = this.access.watcherId();
      const role = this.access.role(ctx.from, ctx.chat?.type);
      if (role) {
        if (role === 'watcher' && previousWatcher === null)
          log.info('control.watcher_bound', { userId: ctx.from?.id, username: ctx.from?.username });
        if (role === 'watcher') {
          const allowed =
            ctx.callbackQuery?.data !== undefined
              ? watcherCallbackAllowed(ctx.callbackQuery.data)
              : watcherCommandAllowed(ctx.message?.text ?? '');
          if (!allowed) {
            const reason =
              'Watcher access is read-only. Trading, fund movements and settings changes are restricted to the owner.';
            log.warn('control.action_denied', {
              userId: ctx.from?.id,
              accessRole: role,
              action: ctx.callbackQuery?.data ?? 'text_input',
            });
            if (ctx.callbackQuery)
              await ctx.answerCallbackQuery({ text: reason, show_alert: true });
            else await this.reply(ctx, reason);
            return;
          }
        }
        if (ctx.from)
          this.viewVersions.set(ctx.from.id, (this.viewVersions.get(ctx.from.id) ?? 0) + 1);
        if (ctx.message?.text?.startsWith('/')) this.interaction(ctx).settingsSourceId = null;
        await withLogContext(
          { updateId: ctx.update.update_id, userId: ctx.from?.id, accessRole: role },
          async () => {
            log.debug('control.update_received', {
              action:
                ctx.callbackQuery?.data ??
                ctx.message?.text?.split(/\s/)[0]?.replace(/^[^/].*$/, 'setting_input'),
            });
            await next();
            log.debug('control.update_handled');
          },
        );
      } else log.warn('control.access_denied', { userId: ctx.from?.id, chatType: ctx.chat?.type });
    });
    this.bot.command(['start', 'settings'], (ctx) => this.home(ctx));
    this.bot.command('wallets', (ctx) => this.wallets(ctx));
    this.bot.command('positions', (ctx) => this.positions(ctx, 0));
    this.bot.command('history', (ctx) => this.history(ctx));
    this.bot.command('pnl', (ctx) => this.pnl(ctx));
    this.bot.command('channels', (ctx) => this.callChannels(ctx));
    this.bot.command('cancel', async (ctx) => {
      if (ctx.from) this.interactions.delete(ctx.from.id);
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
          '/pnl - Daily, weekly and monthly USD profit and loss',
          '/channels - Add and manage monitored call channels',
          '✖️ /cancel · Cancel the current input',
          '',
          message`💰 ${bold('Before enabling a chain')}`,
          'Set buy size and slippage. Priority fees are automatic unless you set an override. All three consistency thresholds start at 30%. Entry filters and exits start disabled.',
          'Open Channels and choose a source to return to its main menu. Configure its Solana or Robinhood settings, then enable the chain and channel. Disabling a channel stops new calls and buys from that source; configured exits for its existing positions continue.',
          'Each channel has independent buy sizes, filters, fees, slippage and exits. SpyDefi feeds require consistency rates; general call channels do not. Obvious update and performance posts are ignored.',
          '',
          message`🎯 ${bold('Profit and sell percentages')}`,
          'Solana exits compare fresh SOL quotes against the confirmed swap entry price. USD PNL includes recorded swap and network fees. Confirmed sale proceeds are net of sell network fees; fills follow your slippage setting.',
          message`Fixed TP: percentage of the ${bold('original entry')}.`,
          message`Trailing TP: percentage of the ${bold('remaining balance')}.`,
          '',
          italic(
            'Settings apply to future positions. Use Apply current exit settings to update an open position. The owner can withdraw SOL or Robinhood ETH from Wallets after confirming the destination and amount.',
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
          message`⚠️ ${bold('Action could not be completed')}\n${settingsError(error)}`,
        );
      }
    });
    this.bot.on('message:text', async (ctx) => {
      try {
        await this.text(ctx, ctx.message.text);
      } catch (error) {
        log.error('control.input_failed', error, {
          inputKind: this.interaction(ctx).pending?.kind,
        });
        await this.reply(ctx, message`⚠️ ${bold('Setting not saved')}\n${settingsError(error)}`);
      }
    });
    this.bot.catch((error) => {
      log.error('control.handler_failed', error.error, { updateId: error.ctx.update.update_id });
    });
  }
  private isWatcher(ctx: Context): boolean {
    return this.access.role(ctx.from, ctx.chat?.type) === 'watcher';
  }
  private settingsSource(ctx: Context) {
    const id = this.interaction(ctx).settingsSourceId;
    return id ? this.store.callChannel(id) : null;
  }
  private currentSettings(ctx: Context, chain: Chain): ChainSettings {
    return this.store.tradingSettings(chain, this.interaction(ctx).settingsSourceId ?? undefined);
  }
  private selectedChannel(ctx: Context): CallChannel | null {
    const selectedId = this.store.metadata(`control:selected-channel:${ctx.from!.id}`);
    const selected = selectedId ? this.store.callChannel(selectedId) : null;
    if (selected) return selected;
    const sources = this.store.callChannels();
    return sources.find((source) => source.mode === 'spydefi') ?? sources[0] ?? null;
  }
  private selectChannel(ctx: Context, id: string): void {
    if (!this.store.callChannel(id)) throw new Error('Channel no longer exists');
    this.store.setMetadata(`control:selected-channel:${ctx.from!.id}`, id);
  }
  private interaction(ctx: Context): InteractionState {
    if (!ctx.from) throw new Error('Telegram user is missing');
    let state = this.interactions.get(ctx.from.id);
    if (!state) {
      state = { pending: null, sale: null, withdrawal: null, settingsSourceId: null };
      this.interactions.set(ctx.from.id, state);
    }
    return state;
  }
  private async reply(ctx: Context, text: string | MessageText): Promise<void> {
    const source = this.settingsSource(ctx);
    if (source)
      text = joinMessages(
        [bold(`${source.title} settings · ${channelStatus(source.enabled)}`), text],
        '\n\n',
      );
    const rendered = renderMessage(
      this.isWatcher(ctx) ? joinMessages([bold('Watcher access: read only'), text], '\n\n') : text,
    );
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
    const source = this.settingsSource(ctx);
    if (source) {
      text = joinMessages(
        [bold(`${source.title} settings · ${channelStatus(source.enabled)}`), text],
        '\n\n',
      );
      keyboard = settingsKeyboard(keyboard, source.settingsKey!);
    }
    const watcher = this.isWatcher(ctx);
    const rendered = renderMessage(
      watcher ? joinMessages([bold('Watcher access: read only'), text], '\n\n') : text,
    );
    const options = {
      entities: rendered.entities,
      reply_markup: watcher ? watcherKeyboard(keyboard) : keyboard,
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
    this.interaction(ctx).settingsSourceId = null;
    this.interaction(ctx).pending = null;
    this.interaction(ctx).withdrawal = null;
    const sources = this.store.callChannels();
    const selected = this.selectedChannel(ctx);
    const reader = this.store.metadata(
      selected ? `reader:last-success:${selected.id}` : 'reader:last-success',
    );
    const enabled = sources.filter((channel) => channel.enabled).length;
    const pending = chains
      .map((chain) => this.store.activeOperation(chain))
      .filter((operation) => operation !== null);
    const text = joinMessages([
      message`🔎 ${bold('SpyDefi tracker')}`,
      '',
      ...(selected
        ? [
            message`${bold('Selected channel:')} ${selected.title} · ${channelStatus(selected.enabled)}`,
            `Channel access: ${selected.status}`,
            ...(selected.mode === 'general'
              ? [`Default chain: ${selected.defaultChain ?? 'None'}`]
              : []),
            '',
          ]
        : ['No channels configured. Add one from Channels.', '']),
      ...(this.config.listenOnly
        ? [
            message`👀 ${bold('LISTEN ONLY')}`,
            italic('Listening to calls. All buys, sells and automatic exits are blocked.'),
            '',
          ]
        : []),
      message`📡 ${bold('Channels:')} ${sources.length} total · ${enabled} on · ${sources.length - enabled} off`,
      message`🕒 ${bold('Reader checked:')} ${reader ? new Date(Number(reader)).toISOString() : 'Connecting…'}`,
      message`📊 ${bold('Open positions:')} ${this.store.positions().length}`,
      '',
      ...(selected
        ? chains.flatMap((chain) => {
            const rules = selected.settings![chain];
            return [
              bold(chainName(chain)),
              `New entries: ${channelStatus(rules.enabled)} · Buy size: ${rules.buySizeNative ?? 'Unset'} ${nativeSymbol[chain]}`,
            ];
          })
        : []),
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
    const keyboard = new InlineKeyboard();
    if (selected) {
      keyboard
        .text(
          `🟣 Solana · ${channelStatus(selected.settings!.solana.enabled)}`,
          settingsCallback(selected.settingsKey!, 'chain:solana'),
        )
        .text(
          `🪶 Robinhood · ${channelStatus(selected.settings!.robinhood.enabled)}`,
          settingsCallback(selected.settingsKey!, 'chain:robinhood'),
        )
        .row();
    }
    keyboard
      .text('👛 Wallets', 'wallets')
      .text('📊 Positions', 'positions:0')
      .row()
      .text('📜 History', 'history');
    if (selected)
      keyboard.text('🚫 Caller blocklist', settingsCallback(selected.settingsKey!, 'blocklist'));
    keyboard.row().text('📞 Recent calls', 'recent').text('💵 PNL', 'pnl:day:all:0');
    for (const operation of pending)
      if (operation.status === 'review')
        keyboard.row().text(`🔄 Reconcile ${operation.chain}`, `reconcile:${operation.id}`);
    keyboard.row().text('📺 Channels', 'channels:0');
    if (selected)
      keyboard.text(
        selected.enabled ? '🔴 Disable channel' : '🟢 Enable channel',
        `channeltoggle:${selected.id}`,
      );
    const channelSummary = joinMessages([
      '',
      bold('All channels'),
      ...(sources.length
        ? sources.map((source) => `${channelStatus(source.enabled)} · ${source.title}`)
        : ['No channels configured.']),
      '',
      italic('Selecting a channel changes the menu. All enabled channels keep running.'),
    ]);
    await this.display(ctx, joinMessages([text, channelSummary]), keyboard);
  }
  private async chainMenu(ctx: Context, chain: Chain): Promise<void> {
    const source = this.settingsSource(ctx);
    const settings = this.currentSettings(ctx, chain);
    const missing = this.engine.readiness(chain, true, settings);
    const tpTargets = exitPlanLines(settings.exits, 'tp', selectedMode(settings.exits, 'tp'));
    const slTargets = exitPlanLines(settings.exits, 'sl', selectedMode(settings.exits, 'sl'));
    const text = joinMessages([
      bold(`${chainName(chain)} settings`),
      '',
      message`⚙️ ${bold('Chain entries:')} ${channelStatus(settings.enabled)}`,
      message`💰 ${bold('Buy size:')} ${settings.buySizeNative ?? 'Unset'} ${nativeSymbol[chain]}`,
      '',
      ...(source?.mode === 'general'
        ? [
            'Consistency is not required for this channel.',
            `Default chain: ${source.defaultChain ?? 'None'}`,
            'The default is used only when a call has no chain hint. It applies to this channel across both chain settings.',
          ]
        : [
            bold('Minimum consistency'),
            `Overall: ${settings.consistency.overall}% · Recent: ${settings.consistency.recent}% · Chain: ${settings.consistency.chain}%`,
          ]),
      '',
      bold(exitSummary(settings.exits, 'tp')),
      ...(tpTargets.length ? tpTargets.map(italic) : [italic('No take-profit targets set.')]),
      '',
      bold(exitSummary(settings.exits, 'sl')),
      ...(slTargets.length ? slTargets.map(italic) : [italic('No stop-loss targets set.')]),
      '',
      missing.length
        ? message`📝 ${bold('Still needed:')} ${missing.join(', ')}`
        : settings.enabled
          ? source && !source.enabled
            ? 'Rules are enabled, but channel monitoring is off.'
            : this.config.listenOnly
              ? message`👀 ${bold('Chain enabled. Listen-only mode blocks trading.')}`
              : message`✅ ${bold('Enabled: matching calls are bought automatically.')}`
          : message`✅ ${bold('Ready to enable entries.')}`,
      ...(this.config.listenOnly ? [message`👀 ${bold('Listen only: trading is blocked.')}`] : []),
      ...(source && !source.enabled
        ? ['Channel monitoring is disabled. Enable it from the channel overview to receive calls.']
        : []),
      '',
      italic(
        'These settings belong only to this channel and chain. Changes apply to future entries; existing positions retain their exit rules until explicitly updated.',
      ),
    ]);
    const keyboard = new InlineKeyboard().text('💰 Buy size', `menu:${chain}:buy`);
    if (source?.mode !== 'general') keyboard.text('🎯 Consistency', `menu:${chain}:consistency`);
    keyboard
      .row()
      .text('🛡️ Entry filters', `menu:${chain}:filters`)
      .text('📈 SL / TP / trailing', `menu:${chain}:exits`)
      .row()
      .text('⛽ Slippage / fees / MEV', `menu:${chain}:execution`)
      .row()
      .text(
        settings.enabled ? '⏸️ Disable chain entries' : '▶️ Enable chain entries',
        `enable:${chain}`,
      );
    if (source?.mode === 'general')
      keyboard
        .row()
        .text('🟣 Default: Solana', `channelchain:${source.id}:solana`)
        .text('🪶 Default: Robinhood', `channelchain:${source.id}:robinhood`)
        .row()
        .text('🚫 No default chain', `channelchain:${source.id}:none`);
    if (source && (source.status !== 'ready' || source.error))
      keyboard.row().text('🔄 Retry channel access', `channelretry:${source.id}`);
    keyboard.row().text('⬅️ Back', 'home');
    await this.display(ctx, text, keyboard);
  }
  private async pnl(
    ctx: Context,
    period: PnlPeriod = 'day',
    chain: PnlChain = 'all',
    offset = 0,
  ): Promise<void> {
    const window = pnlWindow(period, offset, this.config.pnlTimeZone ?? 'UTC');
    const summary = summarizePnl(
      this.store.pnlFills(),
      this.store.positions(),
      this.store.pnlMarks(),
      window,
      chain,
    );
    const key = `${period}:${chain}:${offset}`;
    const keyboard = new InlineKeyboard();
    for (const [value, label] of [
      ['day', '📅 Daily'],
      ['week', '🗓️ Weekly'],
      ['month', '📆 Monthly'],
    ] as const)
      keyboard.text(value === period ? `[${label}]` : label, `pnl:${value}:${chain}:0`);
    keyboard.row();
    for (const [value, label] of [
      ['all', '🌐 All chains'],
      ['solana', '🟣 Solana'],
      ['robinhood', '🟢 Robinhood'],
    ] as const)
      keyboard.text(value === chain ? `[${label}]` : label, `pnl:${period}:${value}:${offset}`);
    keyboard.row().text('⬅️ Previous', `pnl:${period}:${chain}:${offset + 1}`);
    if (offset > 0)
      keyboard
        .text('➡️ Next', `pnl:${period}:${chain}:${offset - 1}`)
        .text('📍 Current', `pnl:${period}:${chain}:0`);
    keyboard.row().text('🔄 Refresh view', `pnl:${key}`);
    if (!this.config.listenOnly && this.pnlTracker)
      keyboard.text('🔄 Update open quotes', `pnlquotes:${key}`);
    await this.display(
      ctx,
      pnlMessage(summary, this.pnlTracker?.updating ?? false),
      keyboard.row().text('⬅️ Back', 'home'),
    );
  }
  private async exitHome(ctx: Context, chain: Chain): Promise<void> {
    const exits = this.currentSettings(ctx, chain).exits;
    await this.display(
      ctx,
      joinMessages([
        bold('Take profit / Stop loss'),
        chainName(chain),
        '',
        exitSummary(exits, 'tp'),
        exitSummary(exits, 'sl'),
        '',
        'Choose TP or SL, select Hard or Trailing, then enable it.',
        italic(
          'Hard exits use a percentage. Trailing exits use activation, distance and sale stages.',
        ),
      ]),
      new InlineKeyboard()
        .text(`🎯 Take profit: ${exitEnabled(exits, 'tp') ? 'On' : 'Off'}`, `exit:${chain}:tp`)
        .row()
        .text(`🛑 Stop loss: ${exitEnabled(exits, 'sl') ? 'On' : 'Off'}`, `exit:${chain}:sl`)
        .row()
        .text('⬅️ Back', `chain:${chain}`),
    );
  }
  private async exitDetails(ctx: Context, chain: Chain, target: ExitKind): Promise<void> {
    const exits = this.currentSettings(ctx, chain).exits;
    if (this.isWatcher(ctx)) {
      const targets = exitPlanLines(exits, target);
      await this.display(
        ctx,
        joinMessages([
          bold(exitSummary(exits, target)),
          chainName(chain),
          '',
          ...(targets.length ? targets : ['No targets configured.']),
        ]),
        new InlineKeyboard().text('⬅️ Back', `menu:${chain}:exits`),
      );
      return;
    }
    const panel = exitPanel(chain, exits, target);
    await this.display(ctx, panel.text, panel.keyboard);
  }
  private async promptExit(
    ctx: Context,
    chain: Chain,
    target: ExitKind,
    mode: ExitMode,
    enableAfter = false,
    append = false,
  ): Promise<void> {
    this.interaction(ctx).pending = {
      kind: 'exit',
      chain,
      target,
      mode,
      enableAfter,
      append,
      sourceId: this.interaction(ctx).settingsSourceId ?? undefined,
    };
    await this.reply(ctx, exitPrompt(target, mode, append));
  }
  private async toggleExit(
    ctx: Context,
    chain: Chain,
    target: ExitKind,
    desired?: boolean,
  ): Promise<void> {
    const exits = this.currentSettings(ctx, chain).exits;
    const enabled = desired ?? !exitEnabled(exits, target);
    if (enabled && !exitReady(exits, target)) {
      await this.promptExit(ctx, chain, target, selectedMode(exits, target), true);
      return;
    }
    this.updateChain(ctx, chain, (settings) => setExitEnabled(settings.exits, target, enabled));
    await this.exitDetails(ctx, chain, target);
  }
  private async group(ctx: Context, chain: Chain, group: EditableField['group']): Promise<void> {
    if (group === 'consistency' && this.settingsSource(ctx)?.mode === 'general')
      throw new Error('Consistency checks do not apply to general call channels');
    if (group === 'exits') {
      await this.exitHome(ctx, chain);
      return;
    }
    const settings = this.currentSettings(ctx, chain);
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
            : 'Classic Robinhood buys require WETH, ETH for gas and token approval prepared in Wallets. They fail without automatic wrapping or approval. Wrap my ETH applies to protected UniswapX buys. Sale proceeds are unwrapped back to ETH.',
        ),
      );
    if (group === 'buy' && chain === 'robinhood')
      lines.push(
        '',
        italic(
          'Classic buys require WETH and approval prepared in Wallets; Wrap my ETH does not apply to Classic buys. Protected UniswapX buys can use this switch to wrap a WETH shortage, adding a transaction and fee. Insufficient funds disables new Robinhood buys for this channel.',
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
          message`💰 ${bold(chain === 'robinhood' ? 'ETH balance:' : 'SOL balance:')} ${formatAmount(balance.nativeRaw, nativeDecimals[chain])} ${nativeSymbol[chain]}`,
        );
        if (balance.wrappedRaw !== null)
          lines.push(
            message`🔄 ${bold('WETH balance:')} ${formatAmount(balance.wrappedRaw, 18)} WETH`,
          );
      } catch (error) {
        log.error('control.balance_failed', error, { chain });
        lines.push(message`⚠️ ${bold('Balance unavailable:')} ${settingsError(error)}`);
      }
      lines.push('');
    }
    lines.push(
      italic(
        'Robinhood buys spend WETH. ETH pays network fees. Use Wrap Robinhood ETH to prepare WETH and its token approval. Classic buys require this preparation. Wrap my ETH allows automatic top-ups for protected UniswapX buys.',
      ),
      '',
    );
    await this.display(
      ctx,
      joinMessages(lines),
      new InlineKeyboard()
        .text('💸 Withdraw SOL', 'withdraw:solana')
        .text('💸 Withdraw Robinhood ETH', 'withdraw:robinhood')
        .row()
        .text('Wrap Robinhood ETH', 'wrap')
        .row()
        .text('🔄 Unwrap idle Robinhood WETH', 'unwrap')
        .row()
        .text('🔄 Refresh', 'wallets')
        .text('⬅️ Back', 'home'),
    );
  }
  private async positions(ctx: Context, requestedPage: number, updating = false): Promise<void> {
    const positions = this.store.positions();
    const { visible, page, pages, keyboard } = positionPage(positions, requestedPage);
    const lines: (string | MessageText)[] = [
      message`📊 ${bold('Open positions')}`,
      `Page ${page + 1} of ${pages} | ${positions.length} open positions`,
      ...(updating ? [italic('Refreshing quotes and PNL...')] : []),
      '',
    ];
    for (const position of visible) {
      lines.push(
        bold(`${label(position.symbol)} (${nativeSymbol[position.chain]})`),
        message`${bold('Entry price:')} ${positionEntryPrice(position, this.store.positionEntryFill(position.id))}`,
        `${formatAmount(position.remainingTokenRaw, position.decimals)} tokens | ${position.lastProfitPercent === null ? 'Value not refreshed' : `${position.lastProfitPercent.toFixed(2)}% in ${nativeSymbol[position.chain]}`}`,
        '',
      );
    }
    if (positions.length === 0) lines.push(italic('No open positions yet.'));
    await this.display(ctx, joinMessages(lines), keyboard);
  }
  private queuePositionRefresh(
    ctx: Context,
    positions: Position[],
    render: () => Promise<void>,
  ): void {
    const userId = ctx.from?.id;
    const version = userId === undefined ? undefined : this.viewVersions.get(userId);
    const work = Promise.all(
      positions.map((position) => {
        let quote = this.positionQuotes.get(position.id);
        if (!quote) {
          quote = this.engine
            .refresh(position)
            .finally(() => this.positionQuotes.delete(position.id));
          this.positionQuotes.set(position.id, quote);
        }
        return quote;
      }),
    )
      .then(async () => {
        if (!this.stopping && userId !== undefined && this.viewVersions.get(userId) === version)
          await render();
      })
      .catch((error) => log.error('control.positions_refresh_failed', error))
      .finally(() => this.refreshTasks.delete(work));
    this.refreshTasks.add(work);
  }
  private async position(ctx: Context, id: string, updating = false, page = 0): Promise<void> {
    const position = this.store.position(id);
    if (!position) throw new Error('Position not found');
    const keyboard = new InlineKeyboard().text('🔄 Refresh PNL', `refresh:${id}:${page}`).row();
    if (position.closedAt === null)
      keyboard
        .text('💸 Sell 25%', `sell:${id}:25`)
        .text('💸 Sell 50%', `sell:${id}:50`)
        .text('💸 Sell all', `sell:${id}:100`)
        .row()
        .text('⚙️ Apply current exit settings', `apply:${id}`)
        .row();
    const exits = position.exits;
    if (position.fundsError) keyboard.text('Resume exits after funding', `resumefunds:${id}`).row();
    const currentValue =
      position.lastValueNativeRaw === null
        ? ''
        : message`💰 ${bold('Estimated remaining value:')} ${formatAmount(position.lastValueNativeRaw, nativeDecimals[position.chain])} ${nativeSymbol[position.chain]}${position.lastValueUsd === null ? '' : ` (approximately $${position.lastValueUsd.toFixed(2)})`}`;
    await this.display(
      ctx,
      joinMessages([
        message`📊 ${bold(`${label(position.symbol)} (${nativeSymbol[position.chain]})`)}`,
        code(position.address),
        ...(position.sourceName || position.sourceId
          ? [
              message`${bold('Source:')} ${position.sourceName ?? this.store.callChannel(position.sourceId!)?.title ?? 'Removed channel'}`,
            ]
          : []),
        ...(updating ? [italic('Refreshing quote and PNL...')] : []),
        ...(position.fundsError
          ? [
              message`${bold('Funds error:')} ${position.fundsError}`,
              italic(
                'Price monitoring continues. Fund the wallet, then resume exits to allow another automatic sale.',
              ),
            ]
          : []),
        '',
        message`${bold('Entry price:')} ${positionEntryPrice(position, this.store.positionEntryFill(position.id))}`,
        message`🪙 ${bold('Remaining:')} ${formatAmount(position.remainingTokenRaw, position.decimals)} tokens`,
        ...(position.entrySwapNativeRaw === undefined
          ? []
          : [
              message`${bold('Swap entry:')} ${formatAmount(position.entrySwapNativeRaw, nativeDecimals[position.chain])} ${nativeSymbol[position.chain]}`,
              message`${bold('Entry network fees:')} ${formatAmount(position.entryFeeNativeRaw, nativeDecimals[position.chain])} ${nativeSymbol[position.chain]}`,
            ]),
        message`💳 ${bold('Entry spending:')} ${formatAmount(position.entryNativeRaw, nativeDecimals[position.chain])} ${nativeSymbol[position.chain]}`,
        ...(position.entryUsd === null
          ? []
          : [message`💵 ${bold('Entry USD estimate:')} $${position.entryUsd.toFixed(2)}`]),
        message`💸 ${bold('Net sale proceeds so far:')} ${formatAmount(position.realizedNativeRaw, nativeDecimals[position.chain])} ${nativeSymbol[position.chain]}`,
        message`📈 ${bold('Quoted gain:')} ${position.lastProfitPercent === null ? 'Not refreshed' : `${position.lastProfitPercent.toFixed(2)}%`}`,
        italic(
          position.chain === 'solana'
            ? 'Quoted gain compares swap prices; network fees and account funding are excluded.'
            : 'Quoted gain is before sell network fees.',
        ),
        ...(currentValue ? [currentValue] : []),
        '',
        bold(exitSummary(exits, 'sl')),
        ...exitPlanLines(exits, 'sl').map(italic),
        bold(exitSummary(exits, 'tp')),
        ...exitPlanLines(exits, 'tp').map(italic),
        ...(position.lastError
          ? ['', message`⚠️ ${bold('Last issue')}\n${position.lastError}`]
          : []),
      ]),
      keyboard.text('⬅️ Back', `positions:${page}`),
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
    const entries = this.store.callerBlocklist(this.interaction(ctx).settingsSourceId ?? undefined);
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
  private async callChannels(ctx: Context, page = 0, removing = false): Promise<void> {
    this.interaction(ctx).settingsSourceId = null;
    const panel = channelList(
      this.store.callChannels(),
      page,
      this.selectedChannel(ctx)?.id,
      removing,
    );
    await this.display(ctx, panel.text, panel.keyboard);
  }
  private async callChannel(ctx: Context, id: string): Promise<void> {
    this.interaction(ctx).settingsSourceId = null;
    const channel = this.store.callChannel(id);
    if (!channel) throw new Error('Channel no longer exists');
    this.selectChannel(ctx, id);
    const panel = channelDetails(channel, this.store.metadata(`reader:last-success:${id}`));
    await this.display(ctx, panel.text, panel.keyboard);
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
        await this.hydrateHistory(
          missing.map((call) => ({ channelId: call.channelId, messageId: call.messageId })),
        );
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
    if (page + 1 < pages) keyboard.text('➡️ Next', `recent:${page + 1}`);
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
                recentCallMessage(
                  call,
                  this.store.callChannels().find((channel) => channel.channelId === call.channelId)
                    ?.username ?? '',
                  this.config.listenOnly,
                ),
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
  private updateChain(ctx: Context, chain: Chain, action: (settings: ChainSettings) => void): void {
    const sourceId = this.interaction(ctx).settingsSourceId;
    if (!sourceId)
      throw new Error('Open Channels and select the channel whose rules you want to edit');
    this.store.updateChannelRules(sourceId, chain, action);
  }
  private async callback(ctx: Context, data: string): Promise<void> {
    const state = this.interaction(ctx);
    const scoped = unpackSettingsCallback(data);
    state.settingsSourceId = null;
    if (scoped.key) {
      const source = this.store.callChannelForSettings(scoped.key);
      if (!source)
        throw new Error('This channel no longer exists. Open Channels to select another source.');
      state.settingsSourceId = source.id;
      this.selectChannel(ctx, source.id);
      data = scoped.data;
    } else if (settingsAction(data)) {
      const action = data.split(':')[0];
      if (!['chain', 'menu', 'exit', 'blocklist'].includes(action ?? ''))
        throw new Error('Settings are managed per channel. Open Channels and select a source.');
      const source = this.selectedChannel(ctx);
      if (!source) throw new Error('Open Channels and select a source to view its settings');
      state.settingsSourceId = source.id;
    }
    const [action, value, option, detail] = data.split(':');
    if (action !== 'confirm') state.sale = null;
    if (action !== 'withdrawconfirm') state.withdrawal = null;
    if (action !== 'wrapconfirm') state.wrapping = undefined;
    state.pending = null;
    switch (action) {
      case 'channels':
        await this.callChannels(ctx, Number(value) || 0);
        return;
      case 'channelremovechoose':
        await this.callChannels(ctx, Number(value) || 0, true);
        return;
      case 'channelpick':
        if (!value) throw new Error('Missing channel');
        this.selectChannel(ctx, value);
        await this.home(ctx);
        return;
      case 'channelview':
        if (value) await this.callChannel(ctx, value);
        return;
      case 'channeladd':
        state.pending = { kind: 'channel_add' };
        await this.reply(
          ctx,
          message`${bold('Add a call channel')}\n\nSend a public channel @username or t.me link, or a private channel invite link. Only broadcast channels are supported.\n\nNew channels start with independent, disabled rules. Configure buy size, filters, slippage and exits under its Solana or Robinhood rules. Then enable that chain and channel monitoring.\n\n${italic('Send /cancel to cancel.')}`,
        );
        return;
      case 'channelretry':
        if (!value || !this.channelRegistry) throw new Error('Channel reader is unavailable');
        await this.channelRegistry.retry(value);
        this.selectChannel(ctx, value);
        await this.home(ctx);
        return;
      case 'channeltoggle':
      case 'channelchain': {
        if (!value) throw new Error('Missing channel');
        const channel = this.store.callChannel(value);
        if (!channel) throw new Error('Channel no longer exists');
        if (action === 'channeltoggle') {
          channel.enabled = !channel.enabled;
          if (channel.enabled) channel.activatedAt = Math.max(Date.now(), channel.activatedAt + 1);
        } else {
          if (channel.mode !== 'general')
            throw new Error('SpyDefi identifies its chain from the call');
          channel.defaultChain = option === 'none' ? null : chainValue(option);
          channel.activatedAt = Math.max(Date.now(), channel.activatedAt + 1);
        }
        this.store.saveCallChannel(channel);
        if (channel.enabled) {
          channel.status = 'unresolved';
          this.store.saveCallChannel(channel);
          void this.channelRegistry
            ?.refresh()
            .catch((error) =>
              log.error('control.channel_refresh_failed', error, { channelId: channel.channelId }),
            );
        }
        this.selectChannel(ctx, channel.id);
        await this.home(ctx);
        return;
      }
      case 'channelremove': {
        const channel = value ? this.store.callChannel(value) : null;
        if (!channel) throw new Error('Channel no longer exists');
        await this.display(
          ctx,
          message`${bold('Remove this call channel?')}\n\n${bold(channel.title)}\nMonitoring and future entries from this source will stop. Existing positions keep their exit rules.`,
          new InlineKeyboard()
            .text('✅ Confirm removal', `channelrmconfirm:${value}`)
            .row()
            .text('✖️ Cancel', 'channels:0'),
        );
        return;
      }
      case 'channelrmconfirm':
        if (!value) return;
        this.store.removeCallChannel(value);
        void this.channelRegistry
          ?.refresh()
          .catch((error) => log.error('control.channel_refresh_failed', error));
        await this.callChannels(ctx);
        return;
      case 'home':
        await this.home(ctx);
        return;
      case 'chain':
        await this.chainMenu(ctx, chainValue(value));
        return;
      case 'menu':
        await this.group(ctx, chainValue(value), groupValue(option));
        return;
      case 'exit': {
        await this.exitDetails(ctx, chainValue(value), exitKind(option));
        return;
      }
      case 'exitmode': {
        const chain = chainValue(value);
        const target = exitKind(option);
        this.updateChain(ctx, chain, (settings) =>
          setExitMode(settings.exits, target, exitMode(detail)),
        );
        await this.exitDetails(ctx, chain, target);
        return;
      }
      case 'exittoggle': {
        await this.toggleExit(ctx, chainValue(value), exitKind(option));
        return;
      }
      case 'exitset':
      case 'exitaddhard': {
        const chain = chainValue(value);
        const target = exitKind(option);
        await this.promptExit(
          ctx,
          chain,
          target,
          action === 'exitaddhard'
            ? 'hard'
            : selectedMode(this.currentSettings(ctx, chain).exits, target),
          false,
          action === 'exitaddhard',
        );
        return;
      }
      case 'exitdel': {
        const chain = chainValue(value);
        const target = exitKind(option);
        if (!detail) throw new Error('Missing stage');
        this.updateChain(ctx, chain, (settings) =>
          removeTrailingStage(settings.exits, target, detail),
        );
        await this.exitDetails(ctx, chain, target);
        return;
      }
      case 'edit': {
        const chain = chainValue(value);
        const field = option ? editableFields[option] : undefined;
        if (!field || !option || (field.chains && !field.chains.includes(chain)))
          throw new Error('Unknown setting');
        state.pending = {
          kind: 'field',
          chain,
          field: option,
          sourceId: state.settingsSourceId ?? undefined,
        };
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
        if (toggle.group === 'exits') {
          const desired = !toggle.value(this.currentSettings(ctx, chain));
          const target = option === 'tp' || option === 'ttp' ? 'tp' : 'sl';
          const mode = option === 'tsl' || option === 'ttp' ? 'trailing' : 'hard';
          if (selectedMode(this.currentSettings(ctx, chain).exits, target) !== mode)
            this.updateChain(ctx, chain, (settings) => setExitMode(settings.exits, target, mode));
          await this.toggleExit(ctx, chain, target, desired);
          return;
        }
        this.updateChain(ctx, chain, toggle.change);
        await this.group(ctx, chain, toggle.group);
        return;
      }
      case 'enable': {
        const chain = chainValue(value);
        if (!this.currentSettings(ctx, chain).enabled) {
          const missing = this.engine.readiness(chain, true, this.currentSettings(ctx, chain));
          if (missing.length) throw new Error(`Configure ${missing.join(', ')}`);
          await this.engine.adapters[chain].verifyNetwork();
        }
        this.updateChain(ctx, chain, (settings) => {
          settings.enabled = !settings.enabled;
        });
        void this.engine
          .tick()
          .catch((error) => log.error('control.chain_tick_failed', error, { chain }));
        await this.chainMenu(ctx, chain);
        return;
      }
      case 'addtp':
        await this.promptExit(ctx, chainValue(value), 'tp', 'hard', false, true);
        return;
      case 'deltp': {
        const chain = chainValue(value);
        this.updateChain(ctx, chain, (settings) => {
          settings.exits.takeProfits = settings.exits.takeProfits.filter(
            (tier) => tier.id !== option,
          );
          if (!settings.exits.takeProfits.length) settings.exits.takeProfitEnabled = false;
        });
        await this.exitDetails(ctx, chain, 'tp');
        return;
      }
      case 'wallets':
        await this.wallets(ctx);
        return;
      case 'positions':
        await this.positions(ctx, Number(value) || 0);
        return;
      case 'positionsrefresh': {
        const page = Number(value) || 0;
        const { visible } = positionPage(this.store.positions(), page);
        await this.positions(ctx, page, true);
        this.queuePositionRefresh(ctx, visible, () => this.positions(ctx, page));
        return;
      }
      case 'position':
        if (value) await this.position(ctx, value, false, Number(option) || 0);
        return;
      case 'resumefunds':
        if (!value) throw new Error('Position not found');
        this.engine.resumeExits(value);
        await this.position(ctx, value);
        return;
      case 'refresh': {
        if (!value) return;
        const page = Number(option) || 0;
        const position = this.store.position(value);
        if (!position) throw new Error('Position not found');
        await this.position(ctx, value, true, page);
        this.queuePositionRefresh(ctx, [position], () => this.position(ctx, value, false, page));
        return;
      }
      case 'history':
        await this.history(ctx);
        return;
      case 'pnl':
        await this.pnl(ctx, pnlPeriod(value), pnlChain(option), Number(detail ?? 0));
        return;
      case 'pnlquotes':
        if (!this.pnlTracker) throw new Error('PNL quote tracking is unavailable');
        this.pnlTracker.requestQuotes();
        await this.pnl(ctx, pnlPeriod(value), pnlChain(option), Number(detail ?? 0));
        return;
      case 'blocklist':
        await this.blocklist(ctx);
        return;
      case 'block':
        state.pending = {
          kind: 'block',
          remove: value === 'remove',
          sourceId: state.settingsSourceId ?? undefined,
        };
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
        state.sale = {
          id: value,
          percentage,
          balance: position.remainingTokenRaw,
          expires: Date.now() + 120_000,
        };
        await this.display(
          ctx,
          message`💸 ${bold('Confirm sale')}\n\nSell ${bold(`${percentage}%`)} of the remaining ${bold(label(position.symbol))} on ${chainName(position.chain)}?\n\n${italic('This position uses the execution settings linked to its source channel.')}`,
          new InlineKeyboard()
            .text('✅ Confirm sale', `confirm:${value}:${percentage}`)
            .row()
            .text('✖️ Cancel', `position:${value}`),
        );
        return;
      }
      case 'confirm': {
        const sale = state.sale;
        state.sale = null;
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
        const source = position.sourceId ? this.store.callChannel(position.sourceId) : null;
        if (position.sourceId && !source)
          throw new Error(
            'The source channel was removed. This position keeps its saved exit rules.',
          );
        await this.display(
          ctx,
          message`⚙️ ${bold('Apply current exit settings?')}\n\nReplace the exit rules for ${bold(label(position.symbol))} with the ${nativeSymbol[position.chain]} exit settings from ${bold(source?.title ?? 'the saved entry settings')}?\n\n⚠️ ${italic('Existing trailing peaks will reset.')}`,
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
        if (position.sourceId && !this.store.callChannel(position.sourceId))
          throw new Error(
            'The source channel was removed. This position keeps its saved exit rules.',
          );
        position.exits = structuredClone(this.store.positionSettings(position).exits);
        position.trailingSl = emptyTrail();
        position.trailingTp = emptyTrail();
        position.trailingStages = {};
        this.store.savePosition(position);
        await this.position(ctx, value);
        return;
      }
      case 'withdraw': {
        if (ctx.from?.id !== this.config.ownerId)
          throw new Error('Only the owner can withdraw funds');
        if (this.config.listenOnly) throw new Error('LISTEN_ONLY=true blocks withdrawals');
        const chain = chainValue(value);
        state.pending = { kind: 'withdraw_address', chain };
        await this.reply(
          ctx,
          message`${bold(`Withdraw ${nativeSymbol[chain]}`)}\n\nNetwork: ${chain === 'solana' ? 'Solana mainnet' : 'Robinhood Chain'}\nSend the destination wallet address.\n\n${italic('Send /cancel to cancel.')}`,
        );
        return;
      }
      case 'withdrawconfirm': {
        if (ctx.from?.id !== this.config.ownerId)
          throw new Error('Only the owner can withdraw funds');
        const withdrawal = state.withdrawal;
        state.withdrawal = null;
        if (!withdrawal || withdrawal.id !== value || withdrawal.expires < Date.now())
          throw new Error('Withdrawal confirmation expired. Start again from Wallets.');
        const id = await this.engine.withdraw(
          withdrawal.chain,
          withdrawal.recipient,
          withdrawal.amount,
          ctx.from.id,
        );
        await this.reply(
          ctx,
          message`${bold('Withdrawal queued')}\nAmount: ${withdrawal.amount} ${nativeSymbol[withdrawal.chain]}\nDestination: ${code(withdrawal.recipient)}\nOperation: ${code(id)}\nConfirmation will be sent after the transaction is confirmed.`,
        );
        return;
      }
      case 'wrap':
        if (ctx.from?.id !== this.config.ownerId) throw new Error('Only the owner can wrap ETH');
        if (this.config.listenOnly) throw new Error('LISTEN_ONLY=true blocks wrapping');
        state.pending = { kind: 'wrap_amount', sourceId: this.selectedChannel(ctx)?.id };
        await this.reply(
          ctx,
          message`${bold('Wrap Robinhood ETH')}\n\nSend the ETH amount to convert into WETH. Keep ETH for network fees. WETH is used directly for buys.\n\n${italic('Send /cancel to cancel.')}`,
        );
        return;
      case 'wrapconfirm': {
        if (ctx.from?.id !== this.config.ownerId) throw new Error('Only the owner can wrap ETH');
        const wrapping = state.wrapping;
        state.wrapping = undefined;
        if (!wrapping || wrapping.id !== value || wrapping.expires < Date.now())
          throw new Error('Wrap confirmation expired. Start again from Wallets.');
        const id = await this.engine.wrap(wrapping.amount, wrapping.sourceId);
        await this.reply(
          ctx,
          message`${bold('Wrap queued')}\nAmount: ${wrapping.amount} ETH\nOperation: ${code(id)}\nConfirmation will be reported here.`,
        );
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
    const state = this.interaction(ctx);
    const pending = state.pending;
    if (!pending) {
      await this.reply(ctx, message`⚙️ Use /settings to choose a setting to edit.`);
      return;
    }
    if ('sourceId' in pending) state.settingsSourceId = pending.sourceId ?? null;
    if (pending.kind === 'wrap_amount') {
      if (ctx.from?.id !== this.config.ownerId) throw new Error('Only the owner can wrap ETH');
      const amount = formatAmount(withdrawalAmount('robinhood', text), 18);
      state.pending = null;
      state.wrapping = {
        id: this.store.newId(),
        amount,
        expires: Date.now() + 120_000,
        sourceId: pending.sourceId,
      };
      await this.display(
        ctx,
        message`${bold('Confirm ETH wrapping')}\n\nConvert ${bold(`${amount} ETH`)} into WETH on Robinhood Chain.\nThis also prepares Permit2 token approval up to this amount if needed, so later buys can use signed permissions. Wrapping and any required approval each incur a network fee.\n\n${italic('Confirmation expires in two minutes.')}`,
        new InlineKeyboard()
          .text('Confirm wrap', `wrapconfirm:${state.wrapping.id}`)
          .row()
          .text('Cancel', 'wallets'),
      );
      return;
    }
    if (pending.kind === 'channel_add') {
      if (!this.channelRegistry) throw new Error('Channel reader is unavailable');
      const channel = await this.channelRegistry.add(text);
      state.pending = null;
      this.selectChannel(ctx, channel.id);
      await this.home(ctx);
      return;
    }
    if (pending.kind === 'withdraw_address' || pending.kind === 'withdraw_amount') {
      if (ctx.from?.id !== this.config.ownerId)
        throw new Error('Only the owner can withdraw funds');
      if (this.config.listenOnly) throw new Error('LISTEN_ONLY=true blocks withdrawals');
      if (pending.kind === 'withdraw_address') {
        const recipient = withdrawalAddress(
          pending.chain,
          text,
          this.engine.adapters[pending.chain].address,
        );
        state.pending = { kind: 'withdraw_amount', chain: pending.chain, recipient };
        await this.reply(
          ctx,
          message`${bold('Withdrawal destination')}\n${code(recipient)}\n\nSend the exact ${nativeSymbol[pending.chain]} amount to transfer. Keep enough native balance for the network fee.\n\n${italic('Send /cancel to cancel.')}`,
        );
        return;
      }
      const amountRaw = withdrawalAmount(pending.chain, text);
      const amount = formatAmount(amountRaw, nativeDecimals[pending.chain]);
      state.pending = null;
      state.withdrawal = {
        id: this.store.newId(),
        chain: pending.chain,
        recipient: pending.recipient,
        amount,
        expires: Date.now() + 120_000,
      };
      await this.display(
        ctx,
        message`${bold('Confirm withdrawal')}\n\nNetwork: ${pending.chain === 'solana' ? 'Solana mainnet' : 'Robinhood Chain'}\nFrom: ${code(this.engine.adapters[pending.chain].address)}\nDestination: ${code(pending.recipient)}\nAmount: ${bold(`${amount} ${nativeSymbol[pending.chain]}`)}\n\nNetwork fees are charged in addition to this amount. Verify the full destination and network before confirming.\n\n${italic('Confirmation expires in two minutes.')}`,
        new InlineKeyboard()
          .text('✅ Confirm withdrawal', `withdrawconfirm:${state.withdrawal.id}`)
          .row()
          .text('✖️ Cancel', 'wallets'),
      );
      return;
    }
    if (pending.kind === 'exit') {
      this.updateChain(ctx, pending.chain, (settings) => {
        if (pending.mode === 'hard')
          saveHardExit(settings.exits, pending.target, text, this.store.newId(), pending.append);
        else saveTrailingStage(settings.exits, pending.target, text, this.store.newId());
        if (pending.enableAfter) setExitEnabled(settings.exits, pending.target, true);
      });
      state.pending = null;
      await this.reply(
        ctx,
        bold(pending.enableAfter ? 'Exit configured and enabled' : 'Exit settings saved'),
      );
      await this.exitDetails(ctx, pending.chain, pending.target);
      return;
    }
    if (pending.kind === 'field') {
      const updated = applyField(
        this.currentSettings(ctx, pending.chain),
        pending.chain,
        pending.field,
        text,
      );
      this.updateChain(ctx, pending.chain, (settings) => {
        Object.assign(settings, updated);
      });
      state.pending = null;
      await this.reply(ctx, message`✅ ${bold('Setting saved')}`);
      await this.group(ctx, pending.chain, editableFields[pending.field]!.group);
      return;
    }
    const callers = text
      .toLowerCase()
      .trim()
      .split(/[\s,]+/)
      .map((value) => value.replace(/^@/, ''));
    if (!callers.length || callers.some((value) => !/^(?:[a-z][a-z0-9_]{3,}|-?\d+)$/.test(value)))
      throw new Error('Use valid caller handles or numeric channel IDs');
    const source = this.settingsSource(ctx);
    if (!source) throw new Error('Open Channels to select a source before editing its blocklist');
    source.blockedCallers = pending.remove
      ? source.blockedCallers!.filter((caller) => !callers.includes(caller.replace(/^@/, '')))
      : [...new Set([...source.blockedCallers!, ...callers])];
    this.store.saveCallChannel(source);
    state.pending = null;
    await this.blocklist(ctx);
  }
  async start(): Promise<void> {
    this.stopping = false;
    await this.bot.init();
    await this.bot.api.setMyCommands([
      { command: 'channels', description: 'Manage monitored call channels' },
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
    void this.bot
      .start({
        timeout: this.pollingTimeoutSeconds,
        allowed_updates: ['message', 'callback_query'],
      })
      .catch((error) => {
        log.error('control.polling_failed', error);
        this.store.disableAllEntries();
        log.warn('chain.entries_disabled', { chains, reason: 'telegram_control_polling_failed' });
      });
    log.debug('control.started', {
      ownerId: this.config.ownerId,
      watcherUsername: this.config.watcherUsername || null,
      listenOnly: this.config.listenOnly,
    });
  }
  private async flushNotifications(): Promise<void> {
    if (this.stopping) return;
    const recipients = this.access.recipients();
    await Promise.all(
      recipients.map(async (recipientId) => {
        if (
          this.sending.has(recipientId) ||
          Date.now() < (this.notificationCooldown.get(recipientId) ?? 0)
        )
          return;
        this.sending.add(recipientId);
        try {
          for (const notification of this.store.notifications(recipientId)) {
            if (this.stopping) break;
            log.debug('notification.sending', { notificationId: notification.id, recipientId });
            const content = notificationMessage(notification.text);
            const rendered = renderMessage(
              recipientId === this.config.ownerId
                ? content
                : joinMessages([bold('Owner activity: read only'), content], '\n\n'),
            );
            const keyboard = notification.solanaSignature
              ? new InlineKeyboard().url(
                  '🔗 View on Solscan',
                  `https://solscan.io/tx/${encodeURIComponent(notification.solanaSignature)}`,
                )
              : notification.robinhoodHash
                ? new InlineKeyboard().url(
                    'View on Blockscout',
                    `https://robinhoodchain.blockscout.com/tx/${encodeURIComponent(notification.robinhoodHash)}`,
                  )
                : undefined;
            await this.bot.api.sendMessage(recipientId, rendered.text, {
              entities: rendered.entities,
              reply_markup: keyboard,
              link_preview_options: { is_disabled: true },
            });
            this.store.delivered(notification.id, recipientId, recipients);
            log.debug('notification.delivered', { notificationId: notification.id, recipientId });
            await delay(1200);
          }
        } catch (error) {
          const retryAt = Date.now() + 30_000;
          this.notificationCooldown.set(recipientId, retryAt);
          log.error('notification.failed', error, {
            recipientId,
            retryAt: new Date(retryAt).toISOString(),
          });
        } finally {
          this.sending.delete(recipientId);
        }
      }),
    );
  }
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.notifier) clearInterval(this.notifier);
    if (this.bot.isRunning()) await this.bot.stop();
    while (this.sending.size > 0 || this.refreshTasks.size > 0 || this.positionQuotes.size > 0)
      await delay(100);
  }
}
