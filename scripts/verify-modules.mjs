/**
 * Мини-«plugin verifier» (CI-гейт `verify`): манифест валиден, вклады
 * существуют, границы импорта не нарушены. Границы держит CI, не дисциплина.
 *
 * Запуск: node scripts/verify-modules.mjs  (после `pnpm build` — entry
 * указывают в dist). Ненулевой exit-код = гейт красный.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
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

for (const [name, { dir, manifest }] of manifests) {
  // Версия ядра: min-версия модуля не выше текущего контракта.
  if (compareCoreVersions(CORE_API_VERSION, manifest.coreApi) < 0) {
    errors.push(`${name}: coreApi ${manifest.coreApi} выше текущего контракта ${CORE_API_VERSION}`);
  }
  // Entry и файловые вклады существуют.
  const mustExist = [['entry', manifest.entry]];
  for (const page of manifest.contributes?.pages ?? []) mustExist.push([`pages/${page.id}.entry`, page.entry]);
  for (const report of manifest.contributes?.reports ?? []) mustExist.push([`reports/${report.id}.entry`, report.entry]);
  for (const [what, rel] of mustExist) {
    if (!existsSync(join(dir, rel))) errors.push(`${name}: ${what} → файла ${rel} нет (сборка прошла?)`);
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
  // Граница импортов: модуль видит только @matrica4/contract и себя.
  scanImports(name, join(dir, 'src'), dir);
}

function scanImports(name, srcDir, moduleRoot) {
  if (!existsSync(srcDir)) return;
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const full = join(srcDir, entry.name);
    if (entry.isDirectory()) {
      scanImports(name, full, moduleRoot);
      continue;
    }
    if (!/\.(ts|tsx|mts|js|mjs)$/.test(entry.name)) continue;
    const text = readFileSync(full, 'utf8');
    const specs = [...text.matchAll(/(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const spec of specs) {
      if (spec.startsWith('.')) {
        const target = resolve(dirname(full), spec);
        if (!target.startsWith(resolve(moduleRoot))) {
          errors.push(`${name}: ${full.slice(root.length + 1)} импортирует за границей модуля: ${spec}`);
        }
        continue;
      }
      if (spec === '@matrica4/contract' || spec.startsWith('node:')) continue;
      errors.push(
        `${name}: ${full.slice(root.length + 1)} импортирует "${spec}" — модулю доступен только @matrica4/contract`,
      );
    }
  }
}

if (errors.length > 0) {
  console.error(`verify: ${errors.length} нарушений:`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`verify: OK — модулей: ${manifests.size}, контракт ${CORE_API_VERSION}`);
