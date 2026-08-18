import { describe, expect, it, vi } from 'vitest';
import { createEventBus } from '../src/eventBus.js';

describe('EventBus', () => {
  it('publish/subscribe/unsubscribe', () => {
    const bus = createEventBus(() => {});
    const seen: unknown[] = [];
    const off = bus.subscribe('t', (p) => seen.push(p));
    bus.publish('t', 1);
    off();
    bus.publish('t', 2);
    expect(seen).toEqual([1]);
  });

  it('ошибка подписчика не глушит остальных и не долетает до издателя', () => {
    const onError = vi.fn();
    const bus = createEventBus(onError);
    const seen: unknown[] = [];
    bus.subscribe('t', () => {
      throw new Error('bad handler');
    });
    bus.subscribe('t', (p) => seen.push(p));
    expect(() => bus.publish('t', 'x')).not.toThrow();
    expect(seen).toEqual(['x']);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('publish в топик без подписчиков — no-op', () => {
    const bus = createEventBus(() => {});
    expect(() => bus.publish('empty', null)).not.toThrow();
  });
});
