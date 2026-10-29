import { NewMessage, EditedMessage } from 'teleproto/events';

export function channelEvents(channelId: string): [NewMessage, EditedMessage] {
  return [new NewMessage({ chats: [channelId] }), new EditedMessage({ chats: [channelId] })];
}
