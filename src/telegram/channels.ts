import { InlineKeyboard } from 'grammy';
import { chains, chainLabel, nativeSymbol, type CallChannel } from '../domain.js';
import { bold, code, italic, joinMessages, message } from './presentation.js';
import { settingsCallback } from './settings-scope.js';
import { exitSummary, exitPlanLines, timeExitSummary } from './exits.js';

export const channelStatus = (enabled: boolean): string => (enabled ? '🟢 On' : '🔴 Off');

export function channelList(
  channels: CallChannel[],
  requestedPage: number,
  selectedId?: string,
  removing = false,
) {
  const pages = Math.max(1, Math.ceil(channels.length / 8));
  const page = Math.min(Math.max(0, Math.floor(requestedPage)), pages - 1);
  const visible = channels.slice(page * 8, page * 8 + 8);
  const selected = channels.find((channel) => channel.id === selectedId);
  const pageAction = removing ? 'channelremovechoose' : 'channels';
  const keyboard = new InlineKeyboard();
  for (const channel of visible)
    keyboard
      .text(
        `📺 ${channel.title.slice(0, 40)} · ${channelStatus(channel.enabled)}`,
        `${removing ? 'channelremove' : 'channelpick'}:${channel.id}`,
      )
      .row();
  if (page > 0) keyboard.text('⬅️ Previous', `${pageAction}:${page - 1}`);
  if (page + 1 < pages) keyboard.text('➡️ Next', `${pageAction}:${page + 1}`);
  if (removing) keyboard.row().text('✖️ Cancel', 'channels:0');
  else {
    keyboard.row().text('➕ Add channel', 'channeladd');
    if (channels.length) keyboard.text('➖ Remove channel', 'channelremovechoose:0');
    keyboard.row().text('🔄 Refresh', `channels:${page}`).text('⬅️ Back', 'home');
  }
  return {
    keyboard,
    text: joinMessages([
      bold(removing ? 'Remove a channel' : 'Channels'),
      `Page ${page + 1} of ${pages} | ${channels.length} configured`,
      '',
      removing
        ? 'Choose a channel to remove. You will be asked to confirm.'
        : 'Choose a channel to open its main menu. Each channel keeps its own trading rules. Other enabled channels keep running.',
      ...(selected && !removing
        ? ['', message`${bold('Selected:')} ${selected.title} · ${channelStatus(selected.enabled)}`]
        : []),
      '',
      ...visible.map(
        (channel) =>
          `${channelStatus(channel.enabled)} · ${channel.title} / ${channel.status}${channel.error ? ` / ${channel.error.slice(0, 180)}` : ''}`,
      ),
      ...(channels.length ? [] : ['No channels configured.']),
      '',
      italic(
        'Only new calls are eligible after enabling a channel. Updates and performance posts are ignored for general channels.',
      ),
    ]),
  };
}

export function channelDetails(channel: CallChannel, lastSuccess: string | null) {
  const key = channel.id;
  const rulesKey = channel.settingsKey!;
  const keyboard = new InlineKeyboard()
    .text('🏠 Open main menu', `channelpick:${key}`)
    .row()
    .text(
      `🟣 Solana: ${channelStatus(channel.settings!.solana.enabled)}`,
      settingsCallback(rulesKey, 'chain:solana'),
    )
    .text(
      `🪶 Robinhood: ${channelStatus(channel.settings!.robinhood.enabled)}`,
      settingsCallback(rulesKey, 'chain:robinhood'),
    )
    .row()
    .text(
      `BNB: ${channelStatus(channel.settings!.bnb.enabled)}`,
      settingsCallback(rulesKey, 'chain:bnb'),
    )
    .row()
    .text(channel.enabled ? '🔴 Disable channel' : '🟢 Enable channel', `channeltoggle:${key}`)
    .row();
  if (channel.mode === 'general')
    keyboard
      .text('🚫 No default chain', `channelchain:${key}:none`)
      .row()
      .text('🟣 Default: Solana', `channelchain:${key}:solana`)
      .text('🪶 Default: Robinhood', `channelchain:${key}:robinhood`)
      .row()
      .text('Default: BNB', `channelchain:${key}:bnb`)
      .row();
  keyboard
    .text('🚫 Caller blocklist', settingsCallback(rulesKey, 'blocklist'))
    .row()
    .text('🔄 Retry channel access', `channelretry:${key}`)
    .row()
    .text('➖ Remove channel', `channelremove:${key}`)
    .row()
    .text('🔄 Refresh', `channelview:${key}`)
    .text('⬅️ Back', 'channels:0');
  return {
    keyboard,
    text: joinMessages([
      bold(channel.title),
      '',
      message`${bold('Channel:')} ${channel.username ? `@${channel.username}` : 'Private channel'}`,
      ...(channel.channelId ? [message`${bold('Telegram ID:')} ${code(channel.channelId)}`] : []),
      `Channel: ${channelStatus(channel.enabled)}`,
      `Access: ${channel.status}`,
      `Mode: ${channel.mode === 'spydefi' ? 'SpyDefi consistency feed' : 'General calls; no consistency requirement'}`,
      `Default chain: ${channel.defaultChain ?? 'None; a reliable chain hint is required for EVM addresses'}`,
      `Last read: ${lastSuccess ? new Date(Number(lastSuccess)).toISOString() : 'Not checked yet'}`,
      ...(channel.error
        ? ['', message`${bold('Access details:')} ${channel.error.slice(0, 700)}`]
        : []),
      '',
      ...chains.flatMap((chain) => {
        const settings = channel.settings![chain];
        return [
          '',
          bold(`${chainLabel[chain]} rules`),
          `New entries: ${settings.enabled ? 'On' : 'Off'} | Buy size: ${settings.buySizeNative ?? 'Unset'} ${nativeSymbol[chain]}`,
          `Slippage: ${settings.slippagePercent === null ? 'Unset' : `${settings.slippagePercent}%`}`,
          exitSummary(settings.exits, 'tp'),
          ...exitPlanLines(settings.exits, 'tp'),
          exitSummary(settings.exits, 'sl'),
          ...exitPlanLines(settings.exits, 'sl'),
          timeExitSummary(settings.exits),
        ];
      }),
      '',
      'Open a chain above to edit rules for this channel only. Set buy size and slippage, then enable that chain. Channel monitoring must also be on.',
      'A token is blocked while reserved or held. Only a fresh call after a confirmed full bot sale permits another entry.',
    ]),
  };
}
