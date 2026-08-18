import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateManifest } from '@matrica4/contract';
import { Kernel } from '../src/kernel.js';
import { createEventBus } from '../src/eventBus.js';

/** Регрессии на находки адверсариального ревью Ф0 (2026-08-18). */

function makeStand() {
  const base = mkdtempSync(join(tmpdir(), 'm4-review-'));
  const modulesDir = join(base, 'modules');
  const stateDir = join(base, 'state');
  mkdirSync(modulesDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  return { base, modulesDir, stateDir };
}

function writeModule(
  modulesDir: string,
  folder: string,
  entryCode: string,
  manifestPatch: Record<string, unknown> = {},
) {
  const dir = join(modulesDir, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      name: folder,
      version: '0.1.0',
      title: folder,
      coreApi: '0.1.0',
      entry: 'index.mjs',
      ...manifestPatch,
    }),
  );
  writeFileSync(join(dir, 'index.mjs'), entryCode);
  return dir;
}

const OK_MODULE = 'export default () => ({ health: () => ({ status: "ok" }) });';

const stands: string[] = [];
afterEach(() => {
  for (const dir of stands.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('safe mode: маркер не переживает запуск', () => {
  it('карантин действует ровно один запуск даже для единственного модуля', async () => {
    const { base, modulesDir, stateDir } = makeStand();
    stands.push(base);
    writeModule(modulesDir, 'solo', OK_MODULE);
    writeFileSync(join(stateDir, 'activating.json'), JSON.stringify({ module: 'solo' }));
    const k1 = new Kernel({ modulesDir, stateDir, log: () => {} });
    expect((await k1.start()).find((r) => r.name === 'solo')?.state).toBe('quarantined');
    await k1.stop();
    const k2 = new Kernel({ modulesDir, stateDir, log: () => {} });
    expect((await k2.start()).find((r) => r.name === 'solo')?.state).toBe('active');
    await k2.stop();
  });

  it('осиротевший маркер несуществующего модуля не карантинит будущий модуль с тем же именем', async () => {
    const { base, modulesDir, stateDir } = makeStand();
    stands.push(base);
    writeModule(modulesDir, 'alive', OK_MODULE);
    writeFileSync(join(stateDir, 'activating.json'), JSON.stringify({ module: 'ghost' }));
    const k1 = new Kernel({ modulesDir, stateDir, log: () => {} });
    await k1.start();
    await k1.stop();
    writeModule(modulesDir, 'ghost', OK_MODULE);
    const k2 = new Kernel({ modulesDir, stateDir, log: () => {} });
    expect((await k2.start()).find((r) => r.name === 'ghost')?.state).toBe('active');
    await k2.stop();
  });
});

describe('рестарт ядра', () => {
  it('start-stop-start на одном ядре: модули не дубликаты самих себя', async () => {
    const { base, modulesDir, stateDir } = makeStand();
    stands.push(base);
    writeModule(modulesDir, 'alpha', OK_MODULE);
    const kernel = new Kernel({ modulesDir, stateDir, log: () => {} });
    expect((await kernel.start())[0]?.state).toBe('active');
    await kernel.stop();
    expect(kernel.report()[0]?.state).toBe('skipped');
    const report2 = await kernel.start();
    expect(report2).toHaveLength(1);
    expect(report2[0]?.state).toBe('active');
    await kernel.stop();
  });
});

describe('коллизии имён', () => {
  it('коллизия имени не затирает уже принятый модуль', async () => {
    const { base, modulesDir, stateDir } = makeStand();
    stands.push(base);
    writeModule(modulesDir, 'aaa-first', OK_MODULE, { name: 'shared-name' });
    writeModule(modulesDir, 'shared-name', OK_MODULE);
    const kernel = new Kernel({ modulesDir, stateDir, log: () => {} });
    const report = await kernel.start();
    const active = report.filter((r) => r.state === 'active');
    expect(active).toHaveLength(1);
    expect(active[0]?.name).toBe('shared-name');
    expect(report.some((r) => r.state === 'skipped' && r.reason?.includes('уже занято'))).toBe(true);
    await kernel.stop();
  });
});

describe('граница entry', () => {
  it('entry с path traversal отвергается', async () => {
    const { base, modulesDir, stateDir } = makeStand();
    stands.push(base);
    writeFileSync(join(base, 'outside.mjs'), OK_MODULE);
    writeModule(modulesDir, 'sneaky', OK_MODULE, { entry: '../../outside.mjs' });
    const kernel = new Kernel({ modulesDir, stateDir, log: () => {} });
    const report = await kernel.start();
    const sneaky = report.find((r) => r.name.includes('sneaky'));
    expect(sneaky?.state).toBe('skipped');
    expect(sneaky?.reason).toMatch(/каталог|невалиден/);
    await kernel.stop();
  });
});

describe('шина: изоляция и неймспейс', () => {
  it('reject async-обработчика уходит в onHandlerError и не глушит соседей', async () => {
    const errors: unknown[] = [];
    const bus = createEventBus((_t, err) => errors.push(err));
    const seen: unknown[] = [];
    bus.subscribe('t', async () => {
      throw new Error('async fail');
    });
    bus.subscribe('t', (p) => seen.push(p));
    bus.publish('t', 7);
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual([7]);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain('async fail');
  });

  it('два subscribe одной функции = две доставки; unsubscribe снимает ровно одну и идемпотентен', () => {
    const bus = createEventBus(() => {});
    let hits = 0;
    const handler = () => {
      hits += 1;
    };
    const off1 = bus.subscribe('t', handler);
    bus.subscribe('t', handler);
    bus.publish('t', null);
    expect(hits).toBe(2);
    off1();
    bus.publish('t', null);
    expect(hits).toBe(3);
    off1();
    bus.publish('t', null);
    expect(hits).toBe(4);
  });

  it('publish модуля в чужой неймспейс отбрасывается, в свой — проходит', async () => {
    const { base, modulesDir, stateDir } = makeStand();
    stands.push(base);
    const code = [
      'export default (ctx) => {',
      "  ctx.events.publish('other.spoofed', 1);",
      "  ctx.events.publish('noisy.legit', 2);",
      '  return {};',
      '};',
    ].join('\n');
    writeModule(modulesDir, 'noisy', code);
    const kernel = new Kernel({ modulesDir, stateDir, log: () => {} });
    const seen: string[] = [];
    kernel.events.subscribe('other.spoofed', () => seen.push('spoofed'));
    kernel.events.subscribe('noisy.legit', () => seen.push('legit'));
    await kernel.start();
    expect(seen).toEqual(['legit']);
    await kernel.stop();
  });

  it('kernel.started публикуется после активации модулей', async () => {
    const { base, modulesDir, stateDir } = makeStand();
    stands.push(base);
    const code = [
      'export default (ctx) => {',
      "  ctx.events.subscribe('kernel.started', () => ctx.events.publish('listener.saw-start', 1));",
      '  return {};',
      '};',
    ].join('\n');
    writeModule(modulesDir, 'listener', code);
    const kernel = new Kernel({ modulesDir, stateDir, log: () => {} });
    const saw: unknown[] = [];
    kernel.events.subscribe('listener.saw-start', (p) => saw.push(p));
    await kernel.start();
    expect(saw).toEqual([1]);
    await kernel.stop();
  });
});

describe('ctx.manifest заморожен', () => {
  it('рантайм-мутация вкладов невозможна', async () => {
    const { base, modulesDir, stateDir } = makeStand();
    stands.push(base);
    const code = [
      'export default (ctx) => {',
      '  const frozen = Object.isFrozen(ctx.manifest) && Object.isFrozen(ctx.manifest.contributes.menu);',
      '  let threw = false;',
      "  try { ctx.manifest.contributes.menu.push({ id: 'x', title: 'x', pageId: 'nope' }); } catch { threw = true; }",
      "  ctx.events.publish('mutant.result', { frozen, threw, len: ctx.manifest.contributes.menu.length });",
      '  return {};',
      '};',
    ].join('\n');
    writeModule(modulesDir, 'mutant', code, {
      contributes: {
        menu: [{ id: 'm', title: 'M', pageId: 'p' }],
        pages: [{ id: 'p', title: 'P', entry: 'index.mjs' }],
      },
    });
    const kernel = new Kernel({ modulesDir, stateDir, log: () => {} });
    const results: unknown[] = [];
    kernel.events.subscribe('mutant.result', (p) => results.push(p));
    await kernel.start();
    expect(results).toEqual([{ frozen: true, threw: true, len: 1 }]);
    await kernel.stop();
  });
});

describe('validateManifest — ужесточения', () => {
  const valid = {
    name: 'demo',
    version: '1.0.0',
    title: 'Demo',
    coreApi: '0.1.0',
    entry: 'dist/index.js',
  };

  it('entry с traversal или абсолютным путём отвергается', () => {
    expect(validateManifest({ ...valid, entry: '../../evil.mjs' }).ok).toBe(false);
    expect(validateManifest({ ...valid, entry: '/etc/passwd' }).ok).toBe(false);
    expect(validateManifest({ ...valid, entry: 'C:\\evil.mjs' }).ok).toBe(false);
    expect(validateManifest({ ...valid, entry: 'dist\\..\\..\\evil.mjs' }).ok).toBe(false);
    expect(validateManifest({ ...valid, entry: 'dist/index.js' }).ok).toBe(true);
  });

  it('pages entry с traversal отвергается', () => {
    const res = validateManifest({
      ...valid,
      contributes: { pages: [{ id: 'p', title: 'P', entry: '../outside.js' }] },
    });
    expect(res.ok).toBe(false);
  });

  it('sync не-boolean и order не-число отвергаются', () => {
    expect(
      validateManifest({ ...valid, contributes: { tables: [{ name: 'demo_x', sync: 'false' }] } }).ok,
    ).toBe(false);
    expect(
      validateManifest({
        ...valid,
        contributes: { menu: [{ id: 'm', title: 'M', pageId: 'p', order: '10' }] },
      }).ok,
    ).toBe(false);
  });

  it('дубликаты id внутри массива вкладов отвергаются', () => {
    const res = validateManifest({
      ...valid,
      contributes: {
        pages: [
          { id: 'same', title: 'A', entry: 'a.js' },
          { id: 'same', title: 'B', entry: 'b.js' },
        ],
      },
    });
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toContain('дубликат');
  });
});
