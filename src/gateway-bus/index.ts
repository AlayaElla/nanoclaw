import { EventEmitter } from 'events';
import { logger } from '../logger.js';

export interface GatewayEventMap {
  // --- 🌍 System: Architecture Lifecycle ---
  'system:startup': {
    action: string;
    config: any;
    bots: any[];
    groups: Record<string, any>;
    tasks: any[];
    channels: { name: string; connected: boolean }[];
    system: any;
    [key: string]: any;
  };
  'system:shutdown': { action?: string; [key: string]: any };

  // --- 💬 Session: Conversation Pipeline ---
  'session:new_message': {
    content?: string;
    from?: string;
    timestamp?: string;
    [key: string]: any;
  };
  'session:before_reset': {
    action: 'new' | 'clear';
    sessionKey: string;
    cfg?: any;
    [key: string]: any;
  };

  // --- 🤖 Agent: Container & Engine ---
  'agent:container_start': {
    group: string;
    containerName?: string;
    [key: string]: any;
  };
  'agent:container_stop': {
    group: string;
    status?: string;
    [key: string]: any;
  };
  'agent:before_prompt_build': {
    systemPrompt?: string;
    context?: any;
    [key: string]: any;
  };
  'agent:tool_use': { group: string; tool: string; [key: string]: any };
  'agent:sdk_task_status': {
    group: string;
    detail: string;
    [key: string]: any;
  };
  'agent:before_message_write': {
    text?: string;
    channelId?: string;
    [key: string]: any;
  };
  'agent:idle': {
    group?: string;
    sessionKey?: string;
    status?: string;
    [key: string]: any;
  };

  // --- 🔌 Channel: Adapters (Like Telegram, Web, etc) ---
  'channel:connect': { channelName?: string; [key: string]: any };
  'channel:disconnect': { channelName?: string; [key: string]: any };

  // --- 📋 Task: Background Jobs ---
  'task:execute': {
    taskId: string;
    group?: string;
    scheduleType?: string;
    [key: string]: any;
  };
  'task:change': { taskId: string; status: string; [key: string]: any };

  // Fallback for custom events
  [event: string]: any;
}

export class AsyncEventEmitter extends EventEmitter {
  public async emitAsync<K extends keyof GatewayEventMap>(
    event: K,
    payload?: GatewayEventMap[K],
    meta?: any,
  ): Promise<boolean> {
    const listeners = this.listeners(event as string | symbol);
    if (listeners.length === 0) {
      return false;
    }

    // Fire all listeners concurrently using Promise.all for true 'fire-and-forget' event broadcasting
    await Promise.all(
      listeners.map(async (listener) => {
        try {
          // Pass payload and optional meta to the listener
          await Promise.resolve(listener.call(this, payload, meta));
        } catch (err) {
          logger.error(
            { err },
            `GatewayBus Error in listener for event ${String(event)}`,
          );
        }
      }),
    );
    return true;
  }
}

export interface HookMeta {
  priority?: number; // Higher runs first, default 0
}

export type HookCallback<T = any> = (
  event: T,
  ctx?: any,
) => Promise<void> | void;

export class HookManager {
  private hooks: Record<string, { cb: HookCallback; priority: number }[]> = {};

  public register(name: string, cb: HookCallback, meta?: HookMeta) {
    if (!this.hooks[name]) this.hooks[name] = [];
    this.hooks[name].push({ cb, priority: meta?.priority ?? 0 });
    // Sort array descending (highest priority first)
    this.hooks[name].sort((a, b) => b.priority - a.priority);
  }

  /**
   * Executes hooks sequentially, allowing preceding hooks to mutate the event object before the next hook runs.
   * After all hooks match and mutate, it automatically broadcasts the final event status on GatewayBus.
   */
  public async execute(name: string, event: any, ctx?: any): Promise<void> {
    if (this.hooks[name]) {
      for (const hook of this.hooks[name]) {
        try {
          await Promise.resolve(hook.cb(event, ctx));
        } catch (err) {
          logger.error({ err, hook: name }, 'Error executing hook');
        }
      }
    }

    // Automatically mirror EVERY hook to the async event bus so that passive observers (using api.on)
    // can track all hook points seamlessly without needing to intercept via registerHook.
    GatewayBus.emitAsync(name as keyof GatewayEventMap, event, ctx).catch(
      () => {},
    );
  }
}

export const GatewayBus = new AsyncEventEmitter();
export const GatewayHooks = new HookManager();
