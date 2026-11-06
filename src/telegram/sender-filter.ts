import { Api } from 'teleproto';
import { senderFilterSchema, type CallChannel, type SourceInfo } from '../domain.js';

export function senderUsernames(text: string): string[] {
  const usernames = text
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
  const result = senderFilterSchema.safeParse({ enabled: true, usernames });
  if (!result.success)
    throw new Error('Enter 1 to 100 Telegram usernames, separated by commas, spaces or newlines');
  return result.data.usernames;
}

export function senderFilterRejection(channel: CallChannel, sender: SourceInfo): string | null {
  const filter = channel.senderFilter;
  if (!filter?.enabled) return null;
  if (!sender.senderId || !sender.senderUsername)
    return 'Sender filter: actual Telegram sender username is unavailable';
  if (!filter.usernames.includes(sender.senderUsername.toLowerCase()))
    return `Sender filter: @${sender.senderUsername} is not in this source's watch list`;
  return null;
}

export function senderIdentity(
  message: Api.Message,
  sender: unknown = message.sender,
): Pick<SourceInfo, 'senderId' | 'senderUsername'> {
  if (!(message.fromId instanceof Api.PeerUser)) return { senderId: null, senderUsername: null };
  const senderId = message.fromId.userId.toString();
  return {
    senderId,
    senderUsername:
      sender instanceof Api.User && sender.id.toString() === senderId
        ? (sender.username?.toLowerCase() ?? null)
        : null,
  };
}
