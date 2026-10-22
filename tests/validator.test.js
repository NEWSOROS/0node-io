import { describe, expect, test } from 'bun:test';
import { normalizeValidatorStats } from '../src/modules/validator.js';

describe('normalizeValidatorStats', () => {
  test('normalizes Stakewiz basis-point commission', () => {
    const stats = normalizeValidatorStats({
      total_apy: 5.5,
      commission: 500,
      uptime: 100,
    });
    expect(stats.commission).toBe(5);
    expect(stats.total_apy).toBe(5.5);
  });

  test('keeps percent commission unchanged', () => {
    expect(normalizeValidatorStats({ commission: 5 }).commission).toBe(5);
  });

  test('drops impossible values without reflecting them into the UI', () => {
    const stats = normalizeValidatorStats({
      commission: 50_000,
      uptime: 101,
      vote_success: 99.75,
    });
    expect(stats).toEqual({ vote_success: 99.75 });
  });

  test('rejects payloads with no usable metrics', () => {
    expect(() => normalizeValidatorStats({ commission: 'not-a-number' })).toThrow();
  });
});
