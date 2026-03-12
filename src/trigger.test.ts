import { describe, it, expect } from 'vitest';
import { isTriggerPresent } from './types.js';

describe('isTriggerPresent', () => {
  const trigger = '@xingmeng';
  const assistantName = '星梦';

  it('matches half-width @ with English name and space', () => {
    expect(isTriggerPresent('@xingmeng hello', trigger, assistantName)).toBe(
      true,
    );
  });

  it('matches half-width @ with Chinese name and space', () => {
    expect(isTriggerPresent('@星梦 你好', trigger, assistantName)).toBe(true);
  });

  it('matches half-width @ with Chinese name and NO space', () => {
    expect(isTriggerPresent('@星梦你好', trigger, assistantName)).toBe(true);
  });

  it('matches full-width ＠ with Chinese name', () => {
    expect(isTriggerPresent('＠星梦你好', trigger, assistantName)).toBe(true);
  });

  it('matches consecutive mentions', () => {
    expect(isTriggerPresent('@星梦@星月', trigger, assistantName)).toBe(true);
  });

  it('does NOT match partial English words', () => {
    // If trigger is xing, it shouldn't match xingmeng
    expect(isTriggerPresent('@xingmeng', 'xing', '星')).toBe(false);
  });

  it('matches at end of string', () => {
    expect(isTriggerPresent('你好 @星梦', trigger, assistantName)).toBe(true);
  });

  it('matches before punctuation', () => {
    expect(isTriggerPresent('@星梦！', trigger, assistantName)).toBe(true);
  });
});
