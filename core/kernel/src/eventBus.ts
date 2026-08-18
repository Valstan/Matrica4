import type { EventBus, Unsubscribe } from '@matrica4/contract';

/**
 * In-process шина событий. Ошибка одного подписчика не глушит остальных
 * и не долетает до издателя (граница модулей — try/catch, концепт v4).
 */
export function createEventBus(onHandlerError: (topic: string, err: unknown) => void): EventBus {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  return {
    publish(topic, payload) {
      const set = handlers.get(topic);
      if (!set) return;
      for (const handler of [...set]) {
        try {
          handler(payload);
        } catch (err) {
          onHandlerError(topic, err);
        }
      }
    },
    subscribe(topic, handler): Unsubscribe {
      let set = handlers.get(topic);
      if (!set) {
        set = new Set();
        handlers.set(topic, set);
      }
      set.add(handler);
      return () => {
        set.delete(handler);
        if (set.size === 0) handlers.delete(topic);
      };
    },
  };
}
