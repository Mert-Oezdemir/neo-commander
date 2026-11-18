import { describe, expect, it } from 'vitest';
import { formatDuration, formatRelative, initials, validateDirectory } from '../lib/format';

describe('format helpers', () => {
  it('formats relative time in Turkish', () => {
    const now = 1_000_000_000_000;
    expect(formatRelative(now - 3_000, now)).toBe('şimdi');
    expect(formatRelative(now - 42_000, now)).toBe('42 sn önce');
    expect(formatRelative(now - 5 * 60_000, now)).toBe('5 dk önce');
    expect(formatRelative(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe('3 sa önce');
  });
  it('formats durations', () => {
    expect(formatDuration(850)).toBe('850 ms');
    expect(formatDuration(2400)).toMatch(/^2,4 sn$/);
  });
  it('validates folder paths like the server', () => {
    expect(validateDirectory('C:\\Users\\Ali\\Belgeler')).toBeNull();
    expect(validateDirectory('/home/ali')).toBeNull();
    expect(validateDirectory('~/Belgeler')).toBeNull();
    expect(validateDirectory('belgeler')).not.toBeNull();
    expect(validateDirectory('  ')).not.toBeNull();
  });
  it('builds initials with Turkish casing', () => {
    expect(initials('ışık deneme')).toBe('ID');
  });
});
