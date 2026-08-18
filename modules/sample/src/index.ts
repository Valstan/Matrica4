import type { ModuleActivate, ModuleHealth, Unsubscribe } from '@matrica4/contract';

/**
 * Модуль-образец: прогон контракта Ф0 живым кодом.
 * Показывает канон: activate → подписка на шину → health → deactivate.
 */
const activate: ModuleActivate = (ctx) => {
  ctx.log.info(`образец активирован против ядра ${ctx.coreApiVersion}`);

  const subscriptions: Unsubscribe[] = [
    ctx.events.subscribe('kernel.started', () => {
      ctx.events.publish('sample.ready', { module: ctx.manifest.name });
    }),
  ];

  return {
    health: (): ModuleHealth => ({ status: 'ok' }),
    deactivate: () => {
      for (const unsubscribe of subscriptions) unsubscribe();
      ctx.log.info('образец деактивирован');
    },
  };
};

export default activate;
