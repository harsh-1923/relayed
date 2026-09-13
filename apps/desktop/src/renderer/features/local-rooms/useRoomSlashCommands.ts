// The composer's slash commands in a local room (docs/LOCAL-ROOMS.md §8.7):
// Claude Code's list for the room's folder, and the four Relayed answers itself.
//
//   /model [name]     sets the room's model, or opens the picker
//   /effort [level]   sets its effort, or opens the picker
//   /clear            the chat's next message starts a new Claude Code session
//   /rename [name]    renames the room, or suggests a name from the conversation
//
// Every other command is sent as the message it is, and Claude Code runs it.
import { useMemo } from 'react';
import { DEFAULT_ROOM_MODEL, isEffortLevel } from '../../../shared/claude.ts';
import { isAppCommand } from '../../../shared/slash-commands.ts';
import type { SlashCommandControl } from '@/features/chat/composer/MessageComposer';
import { call } from '@/lib/ipc';
import { useQuery } from '@/lib/query';

export function useRoomSlashCommands(spaceId: string | undefined, chatId: string | undefined, openModelPicker: () => void): SlashCommandControl | undefined {
  const { rows: commands } = useQuery('local.commands.list', { chatId: chatId ?? '' });
  const { rows } = useQuery('local.rooms.get', { spaceId: spaceId ?? '' });
  const { rows: statuses } = useQuery('claude.status');
  const room = rows?.[0];
  const status = statuses?.[0];

  return useMemo(() => {
    if (!chatId || !room) return undefined;
    const models = status?.state === 'ready' ? status.models : [];

    const sent = async (name: string, args: string): Promise<boolean> => {
      if (!isAppCommand(name)) return false;
      switch (name) {
        case 'model': {
          const wanted = args.toLocaleLowerCase();
          const model = wanted
            ? models.find(entry => [entry.value, entry.resolvedModel, entry.displayName].some(label => label?.toLocaleLowerCase() === wanted))
            : undefined;
          if (!model) { openModelPicker(); return true; }
          const effort = room.effort && model.efforts.includes(room.effort) ? room.effort : null;
          await call(api => api.query('local.rooms.setModel', { spaceId: room.spaceId, model: model.value, effort }));
          return true;
        }
        case 'effort': {
          const level = args.toLocaleLowerCase();
          if (level === 'default') {
            await call(api => api.query('local.rooms.setModel', { spaceId: room.spaceId, model: room.model, effort: null }));
          } else if (isEffortLevel(level)) {
            await call(api => api.query('local.rooms.setModel', { spaceId: room.spaceId, model: room.model ?? DEFAULT_ROOM_MODEL, effort: level }));
          } else {
            openModelPicker();
          }
          return true;
        }
        case 'clear':
          await call(api => api.query('local.chats.clearSession', { chatId }));
          return true;
        case 'rename':
          if (args) await call(api => api.query('local.rooms.rename', { spaceId: room.spaceId, name: args }));
          else await call(api => api.query('local.rooms.regenerateTitle', { spaceId: room.spaceId }));
          return true;
      }
    };

    return {
      commands: commands ?? [],
      // Only the pickers open straight from the menu; the rest take an argument or a confirming Enter.
      chosen: name => {
        if (name !== 'model' && name !== 'effort') return false;
        openModelPicker();
        return true;
      },
      sent,
    };
  }, [chatId, room, status, commands, openModelPicker]);
}
