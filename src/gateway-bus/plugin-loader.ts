import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../config.js';
import {
  GatewayBus,
  GatewayHooks,
  GatewayEventMap,
  HookCallback,
} from './index.js';
import { logger } from '../logger.js';

export interface PluginManifest {
  id?: string;
  path: string; // Add the absolute/relative path to your plugin index.ts or package
  enabled?: boolean;
  config?: any;
}

export interface NanoClawGatewayApi {
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    debug: (msg: string) => void;
    error: (msg: string, err?: any) => void;
  };
  on: <K extends keyof GatewayEventMap>(
    event: K,
    cb: (payload: GatewayEventMap[K], meta?: any) => void | Promise<void>,
  ) => void;
  registerHook: (hook: string, cb: HookCallback, meta?: any) => void;
  registerService: (service: any) => void;
}

/**
 * Reads nanoclaw-plugins.json and loads them.
 */
export async function loadPlugins() {
  const rootDir = process.cwd();
  const pluginConfigFile = path.join(
    rootDir,
    'plugins',
    'nanoclaw-plugins.json',
  );
  if (!fs.existsSync(pluginConfigFile)) {
    // create a default empty config if not exists
    fs.mkdirSync(path.join(rootDir, 'plugins'), { recursive: true });
    fs.writeFileSync(
      pluginConfigFile,
      JSON.stringify({ plugins: [] }, null, 2),
    );
    logger.info(
      `[PluginLoader] Created default plugin config at ${pluginConfigFile}`,
    );
    return;
  }

  try {
    const rawContent = fs.readFileSync(pluginConfigFile, 'utf-8');
    const config = JSON.parse(rawContent);
    const plugins: PluginManifest[] = config.plugins || [];

    for (const pluginInfo of plugins) {
      if (!pluginInfo.path) {
        continue;
      }

      if (pluginInfo.enabled === false) {
        logger.info(
          `[PluginLoader] Skipping disabled plugin: ${pluginInfo.path}`,
        );
        continue;
      }

      try {
        const fullPath = path.resolve(rootDir, 'plugins', pluginInfo.path);
        logger.info(`[PluginLoader] Loading plugin from ${fullPath}`);

        const pluginModule = await import(fullPath);
        const defaultExport = pluginModule.default;

        // Build the Shim API context that mimics OpenClaw's plugin API
        const pluginName =
          pluginInfo.id ||
          pluginInfo.path.split('/').slice(-2, -1)[0] ||
          'unknown';
        const apiCtx: NanoClawGatewayApi = {
          logger: {
            info: (msg: string) => logger.info(`[Plugin:${pluginName}] ${msg}`),
            warn: (msg: string) => logger.warn(`[Plugin:${pluginName}] ${msg}`),
            debug: (msg: string) =>
              logger.debug(`[Plugin:${pluginName}] ${msg}`),
            error: (msg: string, err?: any) =>
              logger.error({ err }, `[Plugin:${pluginName}] ${msg}`),
          },
          on: <K extends keyof GatewayEventMap>(
            event: K,
            cb: (
              payload: GatewayEventMap[K],
              meta?: any,
            ) => void | Promise<void>,
          ) => {
            GatewayBus.on(event as string, cb as any);
          },
          registerHook: (hook: string, cb: HookCallback, meta?: any) => {
            GatewayHooks.register(hook, cb as any, meta);
          },
          registerService: (service: any) => {
            if (service?.start) service.start();
          },
        };

        // Call the plugin — support multiple export shapes:
        //   1. export default function(api, config) { ... }
        //   2. export default { init(api, config) { ... } }
        //   3. module.exports = function(api, config) { ... }
        if (typeof defaultExport === 'function') {
          await defaultExport(apiCtx, pluginInfo.config || {});
        } else if (defaultExport && typeof defaultExport.init === 'function') {
          await defaultExport.init(apiCtx, pluginInfo.config || {});
        } else if (typeof pluginModule === 'function') {
          await pluginModule(apiCtx, pluginInfo.config || {});
        } else {
          logger.warn(
            `[PluginLoader] Plugin ${pluginInfo.path} has no callable export, skipping`,
          );
          continue;
        }

        logger.info(
          `[PluginLoader] ✅ Plugin "${pluginName}" initialized successfully`,
        );
      } catch (err) {
        logger.error(
          { err },
          `[PluginLoader] Failed to load plugin ${pluginInfo.path}`,
        );
      }
    }
  } catch (err) {
    logger.error({ err }, `[PluginLoader] Failed to read plugin config`);
  }
}
