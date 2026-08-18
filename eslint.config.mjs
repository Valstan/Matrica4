import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  // ГРАНИЦА: контракт не импортирует НИЧЕГО (ноль зависимостей — модуль
  // компилируется против одного файла). Дублируется verifier'ом.
  {
    files: ['core/contract/src/**'],
    rules: {
      // Контракт не импортирует ничего внешнего: разрешены только относительные
      // ('./…') пути. Селекторы точнее глобов no-restricted-imports (gitignore-семантика).
      'no-restricted-syntax': [
        'error',
        {
          selector: "ImportDeclaration[source.value=/^[^.]/]",
          message: 'Контракт не импортирует ничего внешнего.',
        },
        {
          selector: "ExportNamedDeclaration[source.value=/^[^.]/]",
          message: 'Контракт не ре-экспортирует ничего внешнего.',
        },
        {
          selector: "ExportAllDeclaration[source.value=/^[^.]/]",
          message: 'Контракт не ре-экспортирует ничего внешнего.',
        },
        {
          selector: "ImportExpression > Literal[value=/^[^.]/]",
          message: 'Контракт не импортирует ничего внешнего.',
        },
      ],
    },
  },
  {
    files: ['scripts/**'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly' } },
  },
  // ГРАНИЦА: модуль видит только @matrica4/contract. Ни kernel, ни внутренности
  // соседей, ни выход за свой каталог. Дублируется verifier'ом (verify-modules).
  {
    files: ['modules/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'node:module', message: 'createRequire — канал обхода границы импортов, запрещён в модулях.' },
            { name: 'module', message: 'createRequire — канал обхода границы импортов, запрещён в модулях.' },
          ],
          patterns: [
            { group: ['@matrica4/kernel', '@matrica4/kernel/*'], message: 'Модуль не импортирует ядро — только @matrica4/contract.' },
            { group: ['../../*'], message: 'Модуль не выходит за свой каталог.' },
          ],
        },
      ],
      // require() и вычисляемый import() слепы для no-restricted-imports —
      // закрываем селекторами (дублируется verifier'ом).
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='require']",
          message: 'require() в модулях запрещён — только статический import @matrica4/contract.',
        },
        {
          selector: "ImportExpression[source.type!='Literal']",
          message: 'import() с нелитеральным аргументом в модулях запрещён — граница непроверяема.',
        },
      ],
    },
  },
  // ГРАНИЦА: kernel зависит только от contract (не от модулей).
  {
    files: ['core/kernel/src/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['@matrica4/module-*', '../../../modules/*'], message: 'Ядро не знает модулей поимённо.' }] },
      ],
    },
  },
);
