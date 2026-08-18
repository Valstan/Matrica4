import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Kernel } from '../src/kernel.js';

/** Стенд: временный каталог модулей + каталог состояния. Entry — .mjs, чтобы ядро импортировало нативно. */
function makeStand() {
  const base = mkdtempSync(join(tmpdir(), 'm4-kernel-'));
  const modulesDir = join(base, 'modules');
  const stateDir = join(base, 'state');
  mkdirSync(modulesDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  return { base, modulesDir, stateDir };
}

function writeModule(
  modulesDir: string,
  name: string,
  entryCode: string,
  manifestPatch: Record<string, unknown> = {},
) {
  const dir = join(modulesDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ name, version: '0.1.0', title: name, coreApi: '0.1.0', entry: 'index.mjs', ...manifestPatch }),
  );
  writeFileSync(join(dir, 'index.mjs'), entryCode);
  return dir;
}

const OK_MODULE = `export default (ctx) => {
  ctx.log.info('up');
  return { health: () => ({ status: 'ok' }) };
};`;

const stands: string[] = [];
afterEach(() => {
  for (const dir of stands.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Kernel', () => {
  it('активирует валидный модуль и отдаёт health', async () => {
    const { base, modulesDir, stateDir } = makeStand();
    stands.push(base);
    writeModule(modulesDir, 'alpha', OK_MODULE);
    const kernel = new Kernel({ modulesDir, stateDir, log: () => {} });
    const report = await kernel.start();
    expect(report).toEqual([{ name: 'alpha', state: 'active', health: { status: 'ok' } }]);
    await kernel.stop();
  });

  it('изолирует модуль, бросивший в activate, и продолжает с остальными', async () => {
    const { base, modulesDir, stateDir } = makeStand();
    stands.push(base);
    writeModule(modulesDir, 'bad', `export default () => { throw new Error('boom'); };`);
    writeModule(modulesDir, 'good', OK_MODULE);
    const kernel = new Kernel({ modulesDir, stateDir, log: () => {} });
    const report = await kernel.start();
    const byName = Object.fromEntries(report.map((r) => [r.name, r]));
    expect(byName.bad?.state).toBe('failed');
    expect(byName.bad?.reason).toContain('boom');
    expect(byName.good?.state).toBe('active');
    await kernel.stop();
  });

  it('safe mode: модуль, уронивший прошлый запуск, уходит в карантин', async () => {
    const { base, modulesDir, stateDir } = makeStand();
    stands.push(base);
    writeModule(modulesDir, 'killer', OK_MODULE);
    writeModule(modulesDir, 'good', OK_MODULE);
    // Симуляция прошлого запуска, погибшего посреди activate killer'а:
    writeFileSync(join(stateDir, 'activating.json'), JSON.stringify({ module: 'killer' }));
    const kernel = new Kernel({ modulesDir, stateDir, log: () => {} });
    const report = await kernel.start();
    const byName = Object.fromEntries(report.map((r) => [r.name, r]));
    expect(byName.killer?.state).toBe('quarantined');
    expect(byName.good?.state).toBe('active');
    await kernel.stop();

    // Следующий запуск: маркера больше нет — карантин снят, модуль поднимается.
    const kernel2 = new Kernel({ modulesDir, stateDir, log: () => {} });
    const report2 = await kernel2.start();
    expect(report2.find((r) => r.name === 'killer')?.state).toBe('active');
    await kernel2.stop();
  });

  it('активирует зависимости раньше зависимых и не поднимает зависимых от упавшего', async () => {
    const { base, modulesDir, stateDir } = makeStand();
    stands.push(base);
    const order: string[] = [];
    writeModule(
      modulesDir,
      'base-mod',
      `export default (ctx) => { ctx.events.publish('order', 'base-mod'); return {}; };`,
    );
    writeModule(
      modulesDir,
      'child-ok',
      `export default (ctx) => { ctx.events.publish('order', 'child-ok'); return {}; };`,
      { dependencies: ['base-mod'] },
    );
    writeModule(modulesDir, 'broken', `export default () => { throw new Error('no'); };`);
    writeModule(modulesDir, 'child-of-broken', OK_MODULE, { dependencies: ['broken'] });
    const kernel = new Kernel({ modulesDir, stateDir, log: () => {} });
    kernel.events.subscribe('order', (name) => order.push(name as string));
    const report = await kernel.start();
    const byName = Object.fromEntries(report.map((r) => [r.name, r]));
    expect(order.indexOf('base-mod')).toBeLessThan(order.indexOf('child-ok'));
    expect(byName['child-of-broken']?.state).toBe('skipped');
    expect(byName['child-of-broken']?.reason).toContain('broken');
    await kernel.stop();
  });

  it('цикл зависимостей не активируется и назван по имени', async () => {
    const { base, modulesDir, stateDir } = makeStand();
    stands.push(base);
    writeModule(modulesDir, 'a', OK_MODULE, { dependencies: ['b'] });
    writeModule(modulesDir, 'b', OK_MODULE, { dependencies: ['a'] });
    const kernel = new Kernel({ modulesDir, stateDir, log: () => {} });
    const report = await kernel.start();
    expect(report.every((r) => r.state === 'skipped')).toBe(true);
    expect(report.some((r) => r.reason?.includes('цикл'))).toBe(true);
    await kernel.stop();
  });

  it('модуль с coreApi выше текущего ядра не грузится', async () => {
    const { base, modulesDir, stateDir } = makeStand();
    stands.push(base);
    writeModule(modulesDir, 'future', OK_MODULE, { coreApi: '99.0.0' });
    const kernel = new Kernel({ modulesDir, stateDir, log: () => {} });
    const report = await kernel.start();
    expect(report[0]?.state).toBe('skipped');
    expect(report[0]?.reason).toContain('99.0.0');
    await kernel.stop();
  });

  it('невалидный манифест отвергается с причиной, не роняя ядро', async () => {
    const { base, modulesDir, stateDir } = makeStand();
    stands.push(base);
    const dir = join(modulesDir, 'noname');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: '0.1.0' }));
    writeModule(modulesDir, 'good', OK_MODULE);
    const kernel = new Kernel({ modulesDir, stateDir, log: () => {} });
    const report = await kernel.start();
    const byName = Object.fromEntries(report.map((r) => [r.name, r]));
    expect(byName.noname?.state).toBe('skipped');
    expect(byName.noname?.reason).toContain('невалиден');
    expect(byName.good?.state).toBe('active');
    await kernel.stop();
  });

  it('deactivate вызывается при stop в обратном порядке', async () => {
    const { base, modulesDir, stateDir } = makeStand();
    stands.push(base);
    writeModule(
      modulesDir,
      'first',
      `export default (ctx) => ({ deactivate: () => ctx.events.publish('down', 'first') });`,
    );
    writeModule(
      modulesDir,
      'second',
      `export default (ctx) => ({ deactivate: () => ctx.events.publish('down', 'second') });`,
      { dependencies: ['first'] },
    );
    const kernel = new Kernel({ modulesDir, stateDir, log: () => {} });
    const down: string[] = [];
    kernel.events.subscribe('down', (name) => down.push(name as string));
    await kernel.start();
    await kernel.stop();
    expect(down).toEqual(['second', 'first']);
  });
});
