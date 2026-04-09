import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
  OnQuestionAnswer,
} from '../types.js';

import { GroupQueue } from '../group-queue.js';

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  groupQueue: GroupQueue;
  onQuestionAnswer?: OnQuestionAnswer;
  registerGroup?: (jid: string, group: RegisteredGroup) => void;
}

export type ChannelFactory = (opts: ChannelOpts) => Channel | Channel[] | null;

const registry = new Map<string, ChannelFactory>();

export function registerChannel(name: string, factory: ChannelFactory): void {
  registry.set(name, factory);
}

export function getChannelFactory(name: string): ChannelFactory | undefined {
  return registry.get(name);
}

export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}
