import { describe, expect, it } from 'vitest';
import { normalizeLiveState, sameLiveState } from './slideLive.js';

describe('normalizeLiveState', () => {
  it('accepts a position and never carries a pending jump', () => {
    expect(normalizeLiveState({ slideId: 'a', step: 2, blank: 'black', jump: '12' })).toEqual({ slideId: 'a', step: 2, blank: 'black', jump: '' });
    expect(normalizeLiveState({ slideId: null, step: 0, blank: null })).toEqual({ slideId: null, step: 0, blank: null, jump: '' });
  });

  it('refuses anything that is not one', () => {
    const bad: unknown[] = [
      null,
      'a',
      {},
      { slideId: 1, step: 0, blank: null },
      { slideId: '', step: 0, blank: null },
      { slideId: 'x'.repeat(101), step: 0, blank: null },
      { slideId: 'a', step: -1, blank: null },
      { slideId: 'a', step: 0.5, blank: null },
      { slideId: 'a', step: 1001, blank: null },
      { slideId: 'a', step: 0, blank: 'red' },
    ];
    for (const input of bad) expect(normalizeLiveState(input)).toBeNull();
  });

  it('compares positions, ignoring the jump', () => {
    const a = { slideId: 'a', step: 1, blank: null, jump: '' } as const;
    expect(sameLiveState(a, { ...a, jump: '3' })).toBe(true);
    expect(sameLiveState(a, { ...a, step: 2 })).toBe(false);
  });
});
