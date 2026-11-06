import { InlineKeyboard } from 'grammy';

const settingsActions = new Set([
  'chain',
  'menu',
  'exit',
  'exitmode',
  'exittoggle',
  'exitset',
  'exitaddhard',
  'exitdel',
  'edit',
  'toggle',
  'enable',
  'addtp',
  'deltp',
  'blocklist',
  'block',
  'senderfilter',
  'sendertoggle',
  'senderset',
]);
export function settingsAction(data: string): boolean {
  return settingsActions.has(data.split(':')[0] ?? '');
}
export function unpackSettingsCallback(data: string): { key: string | null; data: string } {
  const match = /^([a-f0-9]{6}):(.+)$/.exec(data);
  return match ? { key: match[1]!, data: match[2]! } : { key: null, data };
}
export function settingsCallback(key: string, data: string): string {
  if (!/^[a-f0-9]{6}$/.test(key)) throw new Error('Channel settings key is invalid');
  const result = `${key}:${data}`;
  if (Buffer.byteLength(result, 'utf8') > 64) throw new Error('Settings action is too long');
  return result;
}
export function settingsKeyboard(keyboard: InlineKeyboard, key: string): InlineKeyboard {
  return new InlineKeyboard(
    keyboard.inline_keyboard.map((row) =>
      row.map((button) =>
        'callback_data' in button && settingsAction(button.callback_data)
          ? { ...button, callback_data: settingsCallback(key, button.callback_data) }
          : button,
      ),
    ),
  );
}
