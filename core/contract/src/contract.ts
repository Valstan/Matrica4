/**
 * ЕДИНСТВЕННЫЙ файл-контракт API ядра Матрицы 4.
 *
 * Правила эволюции (D-031, концепт v4):
 * - Стабильное не ломается НИКОГДА. Разрешены только аддитивные расширения
 *   (новые опциональные поля, новые методы, новые типы).
 * - Эксперименты живут в неймспейсе `proposed_*` и могут меняться/исчезать.
 *   Модуль, использующий proposed-API, обязан объявить это в манифесте
 *   (`proposedApis`) — verifier следит.
 * - Верхней границы версии ядра в манифесте НЕТ (грабли until-build JetBrains):
 *   модуль объявляет только минимальную версию `coreApi`.
 * - Контракт не импортирует ничего. Ноль зависимостей — модуль компилируется
 *   против одного этого файла.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Версия API ядра
// ─────────────────────────────────────────────────────────────────────────────

/** Текущая версия API ядра (semver `major.minor.patch`). Только растёт. */
export const CORE_API_VERSION = '0.1.0';

/**
 * Сравнение semver-версий контракта: -1 | 0 | 1.
 * Нестрогий парс: нечисловой сегмент читается как 0 (fail-open в сторону
 * «версии равны», а не падения ядра на кривом манифесте — кривизну ловит
 * validateManifest раньше).
 */
export function compareCoreVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split('.').map((s) => Number.parseInt(s, 10) || 0);
  const pb = b.split('.').map((s) => Number.parseInt(s, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Манифест модуля
// ─────────────────────────────────────────────────────────────────────────────

/** Пункт меню, который модуль вкладывает в оболочку. */
export interface MenuContribution {
  /** Уникальный в пределах модуля id пункта. */
  id: string;
  /** Отображаемое название (русский — язык интерфейса завода). */
  title: string;
  /** id страницы (PageContribution.id), которую открывает пункт. */
  pageId: string;
  /** Порядок сортировки внутри группы; меньше — выше. */
  order?: number;
}

/** Страница, которую модуль отдаёт оболочке. */
export interface PageContribution {
  id: string;
  title: string;
  /** Путь до реализации страницы относительно корня модуля (существование проверяет verifier). */
  entry: string;
}

/** Отчёт-пресет, который модуль вкладывает в движок отчётов. */
export interface ReportContribution {
  id: string;
  title: string;
  /** Путь до builder-реализации относительно корня модуля. */
  entry: string;
}

/**
 * Таблица данных модуля. Ядро (core/data) исполняет миграции по декларациям —
 * модулям запрещён собственный DDL. В Ф0 декларация только валидируется;
 * исполнение — Ф2 (мост). Поле `sync` — задел под расширяемый офлайн-синк.
 */
export interface TableContribution {
  /** Имя таблицы. Обязан начинаться с `<module>_` — границу проверяет verifier. */
  name: string;
  /** Участвует ли таблица в офлайн-синхронизации клиентов. */
  sync?: boolean;
}

/** Фоновая задача модуля (исполняется ядром по расписанию). */
export interface JobContribution {
  id: string;
  title: string;
  /** Интервал в секундах (декларативный; исполнение — kernel). */
  intervalSeconds: number;
}

/** Декларативные вклады модуля. Оболочка рендерит их сама (VS Code contribution points, Odoo). */
export interface ModuleContributions {
  menu?: MenuContribution[];
  pages?: PageContribution[];
  reports?: ReportContribution[];
  tables?: TableContribution[];
  jobs?: JobContribution[];
}

/**
 * Манифест модуля — файл `manifest.json` в корне папки модуля.
 * Модуль = папка с манифестом.
 */
export interface ModuleManifest {
  /** Машинное имя: `^[a-z][a-z0-9-]*$`, уникально среди модулей. */
  name: string;
  /** Версия модуля (semver). */
  version: string;
  /** Отображаемое название. */
  title: string;
  /** МИНИМАЛЬНАЯ версия API ядра (semver). Верхней границы нет — намеренно. */
  coreApi: string;
  /** Путь до entry-файла модуля относительно корня модуля. */
  entry: string;
  /** Имена модулей, которые должны быть активированы раньше. */
  dependencies?: string[];
  /** proposed_*-API, которые модуль сознательно использует. */
  proposedApis?: string[];
  contributes?: ModuleContributions;
}

// ─────────────────────────────────────────────────────────────────────────────
// Валидация манифеста (pure, без зависимостей — используют kernel и CI-verifier)
// ─────────────────────────────────────────────────────────────────────────────

export interface ManifestValidationResult {
  ok: boolean;
  /** Человекочитаемые ошибки; пусто при ok=true. */
  errors: string[];
}

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/** Проверка незнакомого JSON на соответствие ModuleManifest. Не бросает. */
export function validateManifest(raw: unknown): ManifestValidationResult {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['манифест должен быть JSON-объектом'] };
  }
  const m = raw as Record<string, unknown>;

  if (typeof m.name !== 'string' || !NAME_RE.test(m.name)) {
    errors.push(`name: обязателен и должен матчить ${NAME_RE} (получено: ${JSON.stringify(m.name)})`);
  }
  if (typeof m.version !== 'string' || !SEMVER_RE.test(m.version)) {
    errors.push(`version: обязателен, semver major.minor.patch (получено: ${JSON.stringify(m.version)})`);
  }
  if (typeof m.title !== 'string' || m.title.length === 0) {
    errors.push('title: обязателен и непуст');
  }
  if (typeof m.coreApi !== 'string' || !SEMVER_RE.test(m.coreApi)) {
    errors.push(`coreApi: обязателен, semver минимальной версии ядра (получено: ${JSON.stringify(m.coreApi)})`);
  }
  if (typeof m.entry !== 'string' || m.entry.length === 0) {
    errors.push('entry: обязателен — путь до entry-файла относительно корня модуля');
  }
  if (m.dependencies !== undefined) {
    if (!Array.isArray(m.dependencies) || m.dependencies.some((d) => typeof d !== 'string')) {
      errors.push('dependencies: массив строк-имён модулей');
    }
  }
  if (m.proposedApis !== undefined) {
    if (
      !Array.isArray(m.proposedApis) ||
      m.proposedApis.some((p) => typeof p !== 'string' || !p.startsWith('proposed_'))
    ) {
      errors.push('proposedApis: массив строк с префиксом proposed_');
    }
  }
  if (m.contributes !== undefined) {
    errors.push(...validateContributions(m.contributes, typeof m.name === 'string' ? m.name : ''));
  }
  return { ok: errors.length === 0, errors };
}

function validateContributions(raw: unknown, moduleName: string): string[] {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return ['contributes: должен быть объектом'];
  }
  const c = raw as Record<string, unknown>;
  const checkArray = (key: string, itemCheck: (item: Record<string, unknown>, at: string) => void) => {
    const value = c[key];
    if (value === undefined) return;
    if (!Array.isArray(value)) {
      errors.push(`contributes.${key}: должен быть массивом`);
      return;
    }
    value.forEach((item, i) => {
      if (typeof item !== 'object' || item === null) {
        errors.push(`contributes.${key}[${i}]: должен быть объектом`);
        return;
      }
      itemCheck(item as Record<string, unknown>, `contributes.${key}[${i}]`);
    });
  };
  const requireString = (item: Record<string, unknown>, field: string, at: string) => {
    if (typeof item[field] !== 'string' || (item[field] as string).length === 0) {
      errors.push(`${at}.${field}: обязателен и непуст`);
    }
  };
  checkArray('menu', (item, at) => {
    requireString(item, 'id', at);
    requireString(item, 'title', at);
    requireString(item, 'pageId', at);
  });
  checkArray('pages', (item, at) => {
    requireString(item, 'id', at);
    requireString(item, 'title', at);
    requireString(item, 'entry', at);
  });
  checkArray('reports', (item, at) => {
    requireString(item, 'id', at);
    requireString(item, 'title', at);
    requireString(item, 'entry', at);
  });
  checkArray('tables', (item, at) => {
    requireString(item, 'name', at);
    if (typeof item.name === 'string' && moduleName && !item.name.startsWith(`${moduleName.replaceAll('-', '_')}_`)) {
      errors.push(`${at}.name: таблица модуля обязана начинаться с "${moduleName.replaceAll('-', '_')}_"`);
    }
  });
  checkArray('jobs', (item, at) => {
    requireString(item, 'id', at);
    requireString(item, 'title', at);
    if (typeof item.intervalSeconds !== 'number' || item.intervalSeconds <= 0) {
      errors.push(`${at}.intervalSeconds: положительное число секунд`);
    }
  });
  return errors;
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime-контракт: то, что модуль получает и отдаёт при активации
// ─────────────────────────────────────────────────────────────────────────────

/** Отписка от события. */
export type Unsubscribe = () => void;

/**
 * Шина событий in-process. Интерфейс намеренно асинхронно-нейтральный:
 * позже её можно подложить брокером без правки модулей (концепт v4).
 * Топики неймспейсятся именем модуля-издателя: `<module>.<event>`.
 */
export interface EventBus {
  publish(topic: string, payload: unknown): void;
  subscribe(topic: string, handler: (payload: unknown) => void): Unsubscribe;
}

/** Журнал модуля (ядро префиксует записи именем модуля). */
export interface ModuleLogger {
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}

/** Состояние здоровья модуля. */
export type ModuleHealthStatus = 'ok' | 'degraded' | 'failed';

export interface ModuleHealth {
  status: ModuleHealthStatus;
  message?: string;
}

/**
 * Контекст, который ядро передаёт модулю при активации.
 * Это ЕДИНСТВЕННАЯ дверь модуля в ядро — модуль не импортирует kernel.
 */
export interface ModuleContext {
  /** Манифест самого модуля (прочитан и провалидирован ядром). */
  readonly manifest: ModuleManifest;
  /** Версия API ядра, под которой модуль запущен. */
  readonly coreApiVersion: string;
  readonly events: EventBus;
  readonly log: ModuleLogger;
}

/** Что модуль возвращает из activate(). Всё опционально. */
export interface ModuleInstance {
  /** Вызывается при штатной остановке ядра. Горячей выгрузки нет — обновление модуля = рестарт. */
  deactivate?(): void | Promise<void>;
  /** Ядро опрашивает здоровье; отсутствие метода = 'ok'. */
  health?(): ModuleHealth;
}

/**
 * Сигнатура entry-модуля: `export default activate`.
 * Бросок из activate НЕ роняет ядро: модуль помечается failed (safe mode).
 */
export type ModuleActivate = (ctx: ModuleContext) => ModuleInstance | Promise<ModuleInstance>;
