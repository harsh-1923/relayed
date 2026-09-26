import type { ComponentType } from 'react';
import {
  Bot, BuildingApartmentOne, ChatDefault, Hashtag, LockClose, PluginAddonPuzzle, UserTwo,
} from '@relayed/icons';
import type { NavigationDestination, NavigationIcon } from './destinations.ts';

const ICONS = {
  agents: Bot,
  chat: ChatDefault,
  apps: PluginAddonPuzzle,
  group: UserTwo,
  hashtag: Hashtag,
  lock: LockClose,
  organization: BuildingApartmentOne,
  people: UserTwo,
} satisfies Record<NavigationIcon, ComponentType<{ className?: string }>>;

/** The one visual vocabulary for a destination in the sidebar and the command menu. */
export function iconForDestination(destination: Pick<NavigationDestination, 'icon'>) {
  return ICONS[destination.icon];
}
