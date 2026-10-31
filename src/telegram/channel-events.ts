import { NewMessage, EditedMessage } from 'teleproto/events';

export function channelEvents(channelId?: string): [NewMessage, EditedMessage] {
  const options = channelId ? { chats: [channelId] } : {};
  return [new NewMessage(options), new EditedMessage(options)];
}
