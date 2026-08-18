import type { EventBus, Unsubscribe } from '@matrica4/contract';

interface Subscription {
  handler: (payload: unknown) => void | Promise<void>;
}

/**
 * In-process шина событий. Ошибка подписчика — синхронный throw ИЛИ reject
 * async-обработчика — не глушит остальных и не долетает до издателя
 * (граница модулей — try/catch, концепт v4; unhandledRejection уронил бы
 * процесс мимо safe mode).
 *
 * Каждый subscribe — независимая подписка (дубликаты одной функции легальны);
 * unsubscribe снимает ровно свою и идемпотентен.
 */
export function createEventBus(onHandlerError: (topic: string, err: unknown) => void): EventBus {
  const subscriptions = new Map<string, Subscription[]>();
  return {
    publish(topic, payload) {
      const list = subscriptions.get(topic);
      if (!list) return;
      for (const sub of [...list]) {
        try {
          const result = sub.handler(payload) as unknown;
          if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
            (result as Promise<unknown>).catch((err) => onHandlerError(topic, err));
          }
        } catch (err) {
          onHandlerError(topic, err);
        }
      }
    },
    subscribe(topic, handler): Unsubscribe {
      let list = subscriptions.get(topic);
      if (!list) {
        list = [];
        subscriptions.set(topic, list);
      }
      const sub: Subscription = { handler };
      list.push(sub);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const current = subscriptions.get(topic);
        if (!current) return;
        const idx = current.indexOf(sub);
        if (idx >= 0) current.splice(idx, 1);
        if (current.length === 0) subscriptions.delete(topic);
      };
    },
  };
}

/**
 * Обёртка шины для модуля: publish разрешён только в свой неймспейс
 * `<module>.<event>`; чужой топик отбрасывается с записью в журнал
 * (не throw — ошибка публикации не должна валить чужой call-stack).
 * Подписка свободная.
 */
export function scopeBusForModule(
  bus: EventBus,
  moduleName: string,
  onViolation: (topic: string) => void,
): EventBus {
  const prefix = `${moduleName}.`;
  return {
    publish(topic, payload) {
      if (!topic.startsWith(prefix)) {
        onViolation(topic);
        return;
      }
      bus.publish(topic, payload);
    },
    subscribe(topic, handler) {
      return bus.subscribe(topic, handler);
    },
  };
}
