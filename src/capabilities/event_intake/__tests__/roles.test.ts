import { describe, test, expect } from 'vitest';
import { isModByRole, DEFAULT_MOD_ROLES } from '../roles.js';

const rolesOf = (...pairs: Array<[string, string]>) => pairs.map(([id, name]) => ({ id, name }));

describe('isModByRole', () => {
  test('matches a configured role by id', () => {
    const MOD_ID = '222222222222222222'; // 18-digit snowflake
    expect(isModByRole(rolesOf(['111111111111111111', 'Miembro'], [MOD_ID, 'Mod']), [MOD_ID])).toBe(true);
    expect(isModByRole(rolesOf(['111111111111111111', 'Miembro']), [MOD_ID])).toBe(false);
  });

  test('matches a configured role by name, accent/case-insensitive', () => {
    expect(isModByRole(rolesOf(['1', 'Moderador']), ['moderador'])).toBe(true);
    expect(isModByRole(rolesOf(['1', 'Administradora']), ['ADMINISTRADORA'])).toBe(true);
  });

  test('empty config falls back to the default approver role ids', () => {
    const modId = DEFAULT_MOD_ROLES[0];
    expect(isModByRole(rolesOf(['1', 'Miembro'], [modId, 'Moderador']), [])).toBe(true);
    expect(isModByRole(rolesOf(['1', 'Miembro']), [])).toBe(false);
  });

  test('a plain member is not a mod', () => {
    expect(isModByRole(rolesOf(['1', 'Miembro'], ['2', 'Verificadx']), ['999'])).toBe(false);
  });
});
