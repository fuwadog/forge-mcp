import { Mutex } from "async-mutex";

const mutexes = new Map<string, Mutex>();

export function getKeyedMutex(key: string): Mutex {
  let m = mutexes.get(key);
  if (!m) {
    m = new Mutex();
    mutexes.set(key, m);
  }
  return m;
}

export function releaseKey(key: string): void {
  mutexes.delete(key);
}

export async function withMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const mutex = getKeyedMutex(key);
  const release = await mutex.acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}
