import type { EventHandler, WebhookProvider } from "./types";

/**
 * Providers and handlers are registered by name at module load
 * (see providers/index.ts) or by tests. Keeping the registry separate from
 * the pipeline keeps ingest/process free of provider imports.
 */
const providers = new Map<string, WebhookProvider>();
const handlers = new Map<string, EventHandler>();

export function registerProvider(provider: WebhookProvider, handler: EventHandler) {
  providers.set(provider.name, provider);
  handlers.set(provider.name, handler);
}

export function getProvider(name: string): WebhookProvider | undefined {
  return providers.get(name);
}

export function getHandler(name: string): EventHandler | undefined {
  return handlers.get(name);
}
