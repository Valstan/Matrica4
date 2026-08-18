import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CORE_API_VERSION,
  compareCoreVersions,
  validateManifest,
  type ModuleActivate,
  type ModuleContext,
  type ModuleHealth,
  type ModuleInstance,
  type ModuleLogger,
  type ModuleManifest,
} from '@matrica4/contract';
import { createEventBus } from './eventBus.js';

export interface KernelOptions {
  /** Каталог с модулями (каждый модуль — папка с manifest.json). */
  modulesDir: string;
  /** Каталог состояния ядра (safe-mode маркеры). */
  stateDir: string;
  /** Приёмник журнала; по умолчанию console. */
  log?: (line: string) => void;
}

export type ModuleState =
  | 'active' // активирован
  | 'failed' // упал при активации этого запуска — изолирован
  | 'quarantined' // safe mode: уронил ПРОШЛЫЙ запуск, в этот раз не грузился
  | 'skipped'; // не грузился: манифест невалиден / версия ядра мала / зависимость не поднялась

export interface ModuleReport {
  name: string;
  state: ModuleState;
  /** Причина для failed/quarantined/skipped. */
  reason?: string;
  health?: ModuleHealth;
}

interface LoadedModule {
  manifest: ModuleManifest;
  dir: string;
  instance?: ModuleInstance;
  state: ModuleState;
  reason?: string;
}

const ACTIVATING_MARKER = 'activating.json';

/**
 * Ядро Ф0: скан модулей → валидация → топологический порядок → активация
 * с safe mode. Горячей выгрузки нет: обновление модуля = рестарт процесса.
 *
 * Safe mode — двухслойный (OBS-модель):
 * 1) activate() бросил → модуль failed, ядро живёт дальше без него;
 * 2) activate() УРОНИЛ процесс (маркер activating остался с прошлого запуска)
 *    → на этом запуске виновник в карантине и не грузится вовсе.
 */
export class Kernel {
  private readonly opts: KernelOptions;
  private readonly modules = new Map<string, LoadedModule>();
  private readonly logSink: (line: string) => void;
  private readonly bus = createEventBus((topic, err) => {
    this.logSink(`[kernel] подписчик топика ${topic} бросил: ${String(err)}`);
  });
  private started = false;

  constructor(opts: KernelOptions) {
    this.opts = opts;
    this.logSink = opts.log ?? ((line) => console.log(line));
  }

  get events() {
    return this.bus;
  }

  /** Имя модуля, чей activate уронил прошлый запуск (карантин), либо null. */
  private readCrashedModule(): string | null {
    const markerPath = join(this.opts.stateDir, ACTIVATING_MARKER);
    if (!existsSync(markerPath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(markerPath, 'utf8')) as { module?: unknown };
      return typeof parsed.module === 'string' ? parsed.module : null;
    } catch {
      return null;
    }
  }

  private writeActivatingMarker(name: string): void {
    mkdirSync(this.opts.stateDir, { recursive: true });
    writeFileSync(join(this.opts.stateDir, ACTIVATING_MARKER), JSON.stringify({ module: name }));
  }

  private clearActivatingMarker(): void {
    rmSync(join(this.opts.stateDir, ACTIVATING_MARKER), { force: true });
  }

  /** Скан + валидация манифестов. Возвращает отчёты по отвергнутым. */
  private discover(): void {
    const root = resolve(this.opts.modulesDir);
    if (!existsSync(root)) return;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      const manifestPath = join(dir, 'manifest.json');
      if (!existsSync(manifestPath)) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
      } catch (err) {
        this.reject(entry.name, dir, `manifest.json не парсится: ${String(err)}`);
        continue;
      }
      const check = validateManifest(raw);
      if (!check.ok) {
        this.reject(entry.name, dir, `манифест невалиден: ${check.errors.join('; ')}`);
        continue;
      }
      const manifest = raw as ModuleManifest;
      if (this.modules.has(manifest.name)) {
        this.reject(entry.name, dir, `имя ${manifest.name} уже занято другим модулем`);
        continue;
      }
      if (compareCoreVersions(CORE_API_VERSION, manifest.coreApi) < 0) {
        this.reject(manifest.name, dir, `требует ядро ≥ ${manifest.coreApi}, текущее ${CORE_API_VERSION}`);
        continue;
      }
      this.modules.set(manifest.name, { manifest, dir, state: 'skipped' });
    }
  }

  private reject(name: string, dir: string, reason: string): void {
    this.logSink(`[kernel] модуль ${name} отвергнут: ${reason}`);
    this.modules.set(name, {
      manifest: { name, version: '0.0.0', title: name, coreApi: '0.0.0', entry: '' },
      dir,
      state: 'skipped',
      reason,
    });
  }

  /** Топологический порядок по dependencies; циклы и неизвестные зависимости → skipped. */
  private order(): string[] {
    const ordered: string[] = [];
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (name: string, chain: string[]): boolean => {
      if (done.has(name)) return this.modules.get(name)?.reason === undefined;
      if (visiting.has(name)) {
        const mod = this.modules.get(name);
        if (mod) mod.reason = `цикл зависимостей: ${[...chain, name].join(' → ')}`;
        return false;
      }
      const mod = this.modules.get(name);
      if (!mod) return false;
      if (mod.reason !== undefined) {
        done.add(name);
        return false;
      }
      visiting.add(name);
      let depsOk = true;
      for (const dep of mod.manifest.dependencies ?? []) {
        if (!this.modules.has(dep)) {
          mod.reason = `зависимость ${dep} не найдена`;
          depsOk = false;
          break;
        }
        if (!visit(dep, [...chain, name])) {
          mod.reason = mod.reason ?? `зависимость ${dep} не поднялась`;
          depsOk = false;
          break;
        }
      }
      visiting.delete(name);
      done.add(name);
      if (depsOk) ordered.push(name);
      return depsOk;
    };
    for (const name of this.modules.keys()) visit(name, []);
    return ordered;
  }

  private makeLogger(name: string): ModuleLogger {
    const write = (level: string, message: string, extra?: Record<string, unknown>) => {
      this.logSink(`[${name}] ${level}: ${message}${extra ? ` ${JSON.stringify(extra)}` : ''}`);
    };
    return {
      info: (m, e) => write('info', m, e),
      warn: (m, e) => write('warn', m, e),
      error: (m, e) => write('error', m, e),
    };
  }

  async start(): Promise<ModuleReport[]> {
    if (this.started) throw new Error('kernel уже запущен');
    this.started = true;
    const quarantined = this.readCrashedModule();
    this.discover();
    const orderedNames = this.order();

    for (const name of orderedNames) {
      const mod = this.modules.get(name);
      if (!mod) continue;
      if (name === quarantined) {
        mod.state = 'quarantined';
        mod.reason = 'safe mode: модуль уронил прошлый запуск';
        this.logSink(`[kernel] ${name} в карантине (safe mode)`);
        continue;
      }
      // Зависимость в карантине/failed → этот модуль не активируем.
      const badDep = (mod.manifest.dependencies ?? []).find(
        (d) => this.modules.get(d)?.state !== 'active',
      );
      if (badDep) {
        mod.state = 'skipped';
        mod.reason = `зависимость ${badDep} не активна`;
        continue;
      }
      const ctx: ModuleContext = {
        manifest: mod.manifest,
        coreApiVersion: CORE_API_VERSION,
        events: this.bus,
        log: this.makeLogger(name),
      };
      try {
        this.writeActivatingMarker(name);
        const entryUrl = pathToFileURL(join(mod.dir, mod.manifest.entry)).href;
        const imported = (await import(entryUrl)) as { default?: ModuleActivate };
        if (typeof imported.default !== 'function') {
          throw new Error(`entry ${mod.manifest.entry} не экспортирует default-функцию activate`);
        }
        mod.instance = await imported.default(ctx);
        mod.state = 'active';
        this.logSink(`[kernel] ${name}@${mod.manifest.version} активирован`);
      } catch (err) {
        mod.state = 'failed';
        mod.reason = String(err);
        this.logSink(`[kernel] ${name} упал при активации, изолирован: ${String(err)}`);
      } finally {
        this.clearActivatingMarker();
      }
    }
    return this.report();
  }

  /** Здоровье и состояние всех обнаруженных модулей. */
  report(): ModuleReport[] {
    return [...this.modules.values()].map((mod) => {
      const base: ModuleReport = { name: mod.manifest.name, state: mod.state };
      if (mod.reason !== undefined) base.reason = mod.reason;
      if (mod.state === 'active') {
        try {
          base.health = mod.instance?.health?.() ?? { status: 'ok' };
        } catch (err) {
          base.health = { status: 'failed', message: `health() бросил: ${String(err)}` };
        }
      }
      return base;
    });
  }

  async stop(): Promise<void> {
    // Деактивация в обратном порядке активации.
    const active = [...this.modules.values()].filter((m) => m.state === 'active').reverse();
    for (const mod of active) {
      try {
        await mod.instance?.deactivate?.();
      } catch (err) {
        this.logSink(`[kernel] ${mod.manifest.name} бросил в deactivate: ${String(err)}`);
      }
    }
    this.started = false;
  }
}
