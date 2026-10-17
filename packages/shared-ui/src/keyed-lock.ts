/**
 * One async operation per key at a time. `run` refuses (resolves `undefined`
 * without calling `operation`) while another operation for the same key is in
 * flight, so a slow request can never land after a later one for the same key.
 * `onChange` fires whenever a key becomes busy or free (to re-render controls).
 */
export interface KeyedLock {
  has(key: string): boolean;
  run<T>(key: string, operation: () => Promise<T>): Promise<T | undefined>;
}

export function createKeyedLock(onChange: () => void = () => {}): KeyedLock {
  const busy = new Set<string>();
  return {
    has: (key) => busy.has(key),
    async run(key, operation) {
      if (busy.has(key)) return undefined;
      busy.add(key);
      onChange();
      try {
        return await operation();
      } finally {
        busy.delete(key);
        onChange();
      }
    },
  };
}
