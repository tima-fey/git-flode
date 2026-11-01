// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FlodePalette } from '../flode-palette';
import { focusFirstField } from '../focus';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  vi.clearAllTimers();
  vi.useRealTimers();
});

it('waits for a late field and stops retrying once it has focus', () => {
  const root = document.createElement('div');
  document.body.append(root);
  focusFirstField(root);
  vi.advanceTimersByTime(160);
  const field = document.createElement('input');
  root.append(field);
  const focus = vi.spyOn(field, 'focus');
  vi.advanceTimersByTime(80);
  expect(document.activeElement).toBe(field);
  vi.runAllTimers();
  expect(focus).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('can cancel retries before a field is ready', () => {
  const root = document.createElement('div');
  document.body.append(root);
  const cancel = focusFirstField(root);
  vi.advanceTimersByTime(80);
  cancel();
  const field = document.createElement('input');
  root.append(field);
  vi.runAllTimers();
  expect(document.activeElement).not.toBe(field);
  expect(vi.getTimerCount()).toBe(0);
});

it('stops after detachment without accessing a torn-down window', () => {
  const root = document.createElement('div');
  document.body.append(root);
  focusFirstField(root);
  root.remove();
  vi.stubGlobal('window', undefined);
  expect(() => vi.runAllTimers()).not.toThrow();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['close', 'disconnect'])('cancels palette autofocus on %s', async (action) => {
  const palette = new FlodePalette();
  palette.open = true;
  document.body.append(palette);
  await palette.updateComplete;
  const field = palette.shadowRoot?.querySelector('input');
  if (!field) throw new Error('Missing palette search field');
  const focus = vi.spyOn(field, 'focus');
  if (action === 'close') {
    palette.open = false;
    await palette.updateComplete;
  } else {
    palette.remove();
  }
  vi.runAllTimers();
  expect(focus).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
