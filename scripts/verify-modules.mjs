/**
 * Мини-«plugin verifier» (CI-гейт `verify`): манифест валиден, вклады
 * существуют, границы импорта не нарушены. Границы держит CI, не дисциплина.
 *
 * Запуск: node scripts/verify-modules.mjs  (после `pnpm build` — entry
 * указывают в dist). Ненулевой exit-код = гейт красный.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contractDist = join(root, 'core', 'contract', 'dist', 'index.js');
if (!existsSync(contractDist)) {
  console.error('verify: сначала соберите контракт (pnpm build) — нужен core/contract/dist');
  process.exit(2);
}
const { validateManifest, compareCoreVersions, CORE_API_VERSION } = await import(
  pathToFileURL(contractDist).href
);

/** proposed_*-API, существующие в контракте сейчас (Ф0 — ни одного). */
const KNOWN_PROPOSED_APIS = new Set();

const errors = [];
const modulesRoot = join(root, 'modules');
const manifests = new Map(); // name -> { dir, manifest }

for (const entry of readdirSync(modulesRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const dir = join(modulesRoot, entry.name);
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    errors.push(`${entry.name}: нет manifest.json (модуль = папка с манифестом)`);
    continue;
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    errors.push(`${entry.name}/manifest.json не парсится: ${err}`);
    continue;
  }
  const check = validateManifest(raw);
  if (!check.ok) {
    errors.push(...check.errors.map((e) => `${entry.name}/manifest.json: ${e}`));
    continue;
  }
  if (manifests.has(raw.name)) {
    errors.push(`${entry.name}: имя "${raw.name}" уже занято модулем в ${manifests.get(raw.name).dir}`);
    continue;
  }
  if (raw.name !== entry.name) {
    errors.push(`${entry.name}: имя в манифесте ("${raw.name}") обязано совпадать с именем папки`);
  }
  manifests.set(raw.name, { dir, manifest: raw });
}

const SPEC_PATTERNS = [
  /\bfrom\s+['"]([^'"]+)['"]/g, // import|export … from '…'
  /\bimport\s+['"]([^'"]+)['"]/g, // side-effect import '…'
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic import('литерал')
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // require('литерал')
];

// Префиксная свобода table-неймспейсов между модулями: `report` и `report-core`
// дают префиксы report_ и report_core_ — второй вложен в первый, значит таблица
// report_core_settings валидна для обоих. Такие пары имён запрещены глобально.
const tablePrefixes = new Map([...manifests.keys()].map((n) => [n, `${n.replaceAll('-', '_')}_`]));
for (const [a, pa] of tablePrefixes) {
  for (const [b, pb] of tablePrefixes) {
    if (a !== b && pb.startsWith(pa)) {
      errors.push(`неймспейс таблиц модуля "${b}" (${pb}) вложен в неймспейс "${a}" (${pa}) — переименуйте один из модулей`);
    }
  }
}
const seenTables = new Map();
for (const [name, { manifest }] of manifests) {
  for (const t of manifest.contributes?.tables ?? []) {
    if (seenTables.has(t.name)) errors.push(`таблица ${t.name} объявлена и модулем ${seenTables.get(t.name)}, и модулем ${name}`);
    seenTables.set(t.name, name);
  }
}

for (const [name, { dir, manifest }] of manifests) {
  // Версия ядра: min-версия модуля не выше текущего контракта.
  if (compareCoreVersions(CORE_API_VERSION, manifest.coreApi) < 0) {
    errors.push(`${name}: coreApi ${manifest.coreApi} выше текущего контракта ${CORE_API_VERSION}`);
  }
  // Entry и файловые вклады существуют И лежат внутри каталога модуля.
  const mustExist = [['entry', manifest.entry]];
  for (const page of manifest.contributes?.pages ?? []) mustExist.push([`pages/${page.id}.entry`, page.entry]);
  for (const report of manifest.contributes?.reports ?? []) mustExist.push([`reports/${report.id}.entry`, report.entry]);
  for (const [what, rel] of mustExist) {
    const target = resolve(dir, rel);
    if (!target.startsWith(resolve(dir) + sep)) {
      errors.push(`${name}: ${what} → путь ${rel} выходит за каталог модуля`);
      continue;
    }
    if (!existsSync(target)) errors.push(`${name}: ${what} → файла ${rel} нет (сборка прошла?)`);
  }
  // Пункты меню указывают на существующие страницы.
  const pageIds = new Set((manifest.contributes?.pages ?? []).map((p) => p.id));
  for (const item of manifest.contributes?.menu ?? []) {
    if (!pageIds.has(item.pageId)) errors.push(`${name}: menu/${item.id} указывает на несуществующую страницу ${item.pageId}`);
  }
  // Зависимости — только на известные модули.
  for (const dep of manifest.dependencies ?? []) {
    if (!manifests.has(dep)) errors.push(`${name}: зависимость "${dep}" не найдена среди модулей`);
  }
  // proposed_*-API — только объявленные контрактом.
  for (const api of manifest.proposedApis ?? []) {
    if (!KNOWN_PROPOSED_APIS.has(api)) errors.push(`${name}: proposed-API "${api}" в контракте не существует`);
  }
  // Runtime-зависимости package.json: модулю доступен только контракт.
  // (Иначе граница обходится дописыванием пакета в deps + require в обход сканера.)
  const pkgPath = join(dir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      for (const dep of Object.keys(pkg.dependencies ?? {})) {
        if (dep !== '@matrica4/contract') {
          errors.push(`${name}: package.json dependencies содержит "${dep}" — модулю доступен только @matrica4/contract`);
        }
      }
    } catch (err) {
      errors.push(`${name}: package.json не парсится: ${err}`);
    }
  }
  // Граница импортов: модуль видит только @matrica4/contract и себя.
  scanImports(name, dir, dir);
}

function scanImports(name, scanDir, moduleRoot) {
  if (!existsSync(scanDir)) return;
  for (const entry of readdirSync(scanDir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(scanDir, entry.name);
    if (entry.isDirectory()) {
      scanImports(name, full, moduleRoot);
      continue;
    }
    if (!/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) continue;
    const rel = full.slice(root.length + 1);
    const text = readFileSync(full, 'utf8');
    // Каналы обхода статического анализа запрещены как таковые.
    if (/createRequire/.test(text)) {
      errors.push(`${name}: ${rel} использует createRequire — канал обхода границы импортов запрещён`);
    }
    if (/\bimport\s*\(\s*[^'")\s]/.test(text)) {
      errors.push(`${name}: ${rel} использует import() с нелитеральным аргументом — запрещено (граница непроверяема)`);
    }
    if (/\brequire\s*\(\s*[^'")\s]/.test(text)) {
      errors.push(`${name}: ${rel} использует require() с нелитеральным аргументом — запрещено`);
    }
    const specs = SPEC_PATTERNS.flatMap((re) => [...text.matchAll(re)].map((m) => m[1]));
    for (const spec of specs) {
      if (spec.startsWith('.')) {
        const target = resolve(dirname(full), spec);
        if (!target.startsWith(resolve(moduleRoot) + sep)) {
          errors.push(`${name}: ${rel} импортирует за границей модуля: ${spec}`);
        }
        continue;
      }
      if (spec === '@matrica4/contract') continue;
      if (spec === 'node:module') {
        errors.push(`${name}: ${rel} импортирует node:module (createRequire) — запрещено`);
        continue;
      }
      if (spec.startsWith('node:')) continue;
      errors.push(`${name}: ${rel} импортирует "${spec}" — модулю доступен только @matrica4/contract`);
    }
  }
}

if (errors.length > 0) {
  console.error(`verify: ${errors.length} нарушений:`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`verify: OK — модулей: ${manifests.size}, контракт ${CORE_API_VERSION}`);
