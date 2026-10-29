import type { MessageEntity } from 'grammy/types';

export interface MessageText {
  text: string;
  entities: MessageEntity[];
}
type Part = MessageText | string | number;

export function joinMessages(parts: readonly Part[], separator = '\n'): MessageText {
  const result: MessageText = { text: '', entities: [] };
  for (const [index, part] of parts.entries()) {
    if (index > 0) result.text += separator;
    if (typeof part !== 'object') {
      result.text += String(part);
      continue;
    }
    const offset = result.text.length;
    result.text += part.text;
    result.entities.push(
      ...part.entities.map((entity) => ({ ...entity, offset: entity.offset + offset })),
    );
  }
  return result;
}

export function message(strings: TemplateStringsArray, ...values: Part[]): MessageText {
  const parts: Part[] = [];
  for (const [index, literal] of strings.entries()) {
    parts.push(literal);
    const value = values[index];
    if (value !== undefined) parts.push(value);
  }
  return joinMessages(parts, '');
}

function styled(type: 'bold' | 'italic' | 'code', value: string): MessageText {
  return { text: value, entities: value.length ? [{ type, offset: 0, length: value.length }] : [] };
}
export const bold = (value: string): MessageText => styled('bold', value);
export const italic = (value: string): MessageText => styled('italic', value);
export const code = (value: string): MessageText => styled('code', value);
export const link = (value: string, url: string): MessageText => ({
  text: value,
  entities: value.length ? [{ type: 'text_link', offset: 0, length: value.length, url }] : [],
});

export function renderMessage(value: string | MessageText, limit = 3900): MessageText {
  const full = typeof value === 'string' ? { text: value, entities: [] } : value;
  if (full.text.length <= limit) return full;
  let text = full.text.slice(0, limit - 3);
  if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  const length = text.length;
  return {
    text: `${text}\n\n…`,
    entities: full.entities
      .filter((entity) => entity.offset < length)
      .map((entity) => ({ ...entity, length: Math.min(entity.length, length - entity.offset) })),
  };
}

export function notificationMessage(text: string): MessageText {
  const [heading = '', ...lines] = text.split('\n');
  const icon = /review required/i.test(heading)
    ? '🛑'
    : /failed|cannot|issue|uncertain/i.test(heading)
      ? '⚠️'
      : /bought|received|sold|proceeds|unwrapped/i.test(heading)
        ? '✅'
        : /connected/i.test(heading)
          ? '📡'
          : /pending|awaiting|queued/i.test(heading)
            ? '⏳'
            : '🔔';
  return joinMessages([
    message`${icon} ${bold(heading)}`,
    ...lines.map((line) => {
      const reference = /^(Transaction|Operation):\s*(.+)$/.exec(line);
      if (reference) return message`${reference[1]!}: ${code(reference[2]!)}`;
      const detail = /^(Reason|Sold|Remaining|Net proceeds):\s*(.+)$/.exec(line);
      return detail ? message`${bold(`${detail[1]!}:`)} ${detail[2]!}` : line;
    }),
  ]);
}
