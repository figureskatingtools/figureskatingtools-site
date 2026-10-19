import { describe, expect, it, vi } from 'vitest';
import { createKeyedLock } from '../src/keyed-lock.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createKeyedLock', () => {
  it('refuses a second operation for the same key while the first is in flight', async () => {
    const lock = createKeyedLock();
    const put = deferred<string>();
    const remove = vi.fn(async () => 'removed');

    const first = lock.run('user-1', () => put.promise);
    expect(lock.has('user-1')).toBe(true);
    await expect(lock.run('user-1', remove)).resolves.toBeUndefined();
    expect(remove).not.toHaveBeenCalled();

    put.resolve('saved');
    await expect(first).resolves.toBe('saved');
    expect(lock.has('user-1')).toBe(false);
    await expect(lock.run('user-1', remove)).resolves.toBe('removed');
  });

  it('keeps keys independent', async () => {
    const lock = createKeyedLock();
    const slow = deferred<void>();
    const pending = lock.run('a', () => slow.promise);
    await expect(lock.run('b', async () => 'b done')).resolves.toBe('b done');
    slow.resolve();
    await pending;
  });

  it('frees the key when the operation fails', async () => {
    const lock = createKeyedLock();
    await expect(lock.run('a', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(lock.has('a')).toBe(false);
  });

  it('reports busy and free transitions', async () => {
    const seen: boolean[] = [];
    const lock = createKeyedLock(() => seen.push(lock.has('a')));
    await lock.run('a', async () => undefined);
    expect(seen).toEqual([true, false]);
  });
});
