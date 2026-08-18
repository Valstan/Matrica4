import { describe, expect, it } from 'vitest';
import { compareCoreVersions, validateManifest } from '@matrica4/contract';

describe('compareCoreVersions', () => {
  it('сравнивает по числам, не по строкам', () => {
    expect(compareCoreVersions('0.9.0', '0.10.0')).toBe(-1);
    expect(compareCoreVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareCoreVersions('2.0.0', '1.99.99')).toBe(1);
  });
});

describe('validateManifest', () => {
  const valid = {
    name: 'demo',
    version: '1.0.0',
    title: 'Демо',
    coreApi: '0.1.0',
    entry: 'dist/index.js',
  };

  it('принимает минимальный валидный манифест', () => {
    expect(validateManifest(valid)).toEqual({ ok: true, errors: [] });
  });

  it('отвергает не-объект и собирает ошибки по полям', () => {
    expect(validateManifest(null).ok).toBe(false);
    const res = validateManifest({ name: 'Bad Name', version: 'x' });
    expect(res.ok).toBe(false);
    expect(res.errors.join('\n')).toMatch(/name:/);
    expect(res.errors.join('\n')).toMatch(/version:/);
    expect(res.errors.join('\n')).toMatch(/title:/);
    expect(res.errors.join('\n')).toMatch(/coreApi:/);
    expect(res.errors.join('\n')).toMatch(/entry:/);
  });

  it('таблицы модуля обязаны носить префикс модуля', () => {
    const res = validateManifest({
      ...valid,
      name: 'my-mod',
      contributes: { tables: [{ name: 'other_notes' }] },
    });
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toContain('my_mod_');
  });

  it('proposedApis требует префикс proposed_', () => {
    const res = validateManifest({ ...valid, proposedApis: ['experimental_x'] });
    expect(res.ok).toBe(false);
  });

  it('меню/страницы/джобы проверяются по полям', () => {
    const res = validateManifest({
      ...valid,
      contributes: {
        menu: [{ id: 'm', title: 'М' }],
        jobs: [{ id: 'j', title: 'Дж', intervalSeconds: -5 }],
      },
    });
    expect(res.ok).toBe(false);
    expect(res.errors.join('\n')).toMatch(/menu\[0\]\.pageId/);
    expect(res.errors.join('\n')).toMatch(/jobs\[0\]\.intervalSeconds/);
  });
});
