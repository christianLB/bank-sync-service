import { getRedis } from './redis';
import { logger } from '../logger';

const LOCK_PREFIX = 'gc:sync:lock:';
const DEFAULT_LOCK_TTL = 15 * 60; // 15 minutes

export interface LockOptions {
  ttl?: number;
  retries?: number;
  retryDelay?: number;
}

export class Lock {
  private key: string;
  private value: string;
  private ttl: number;

  constructor(
    private accountId: string,
    private options: LockOptions = {}
  ) {
    this.key = `${LOCK_PREFIX}${accountId}`;
    this.value = `${Date.now()}_${Math.random()}`;
    this.ttl = options.ttl || DEFAULT_LOCK_TTL;
  }

  async acquire(): Promise<boolean> {
    const redis = getRedis();
    const retries = this.options.retries || 3;
    const retryDelay = this.options.retryDelay || 1000;

    for (let i = 0; i < retries; i++) {
      try {
        const result = await redis.set(
          this.key,
          this.value,
          'EX',
          this.ttl,
          'NX'
        );

        if (result === 'OK') {
          logger.debug({ accountId: this.accountId }, 'Lock acquired');
          return true;
        }

        if (i < retries - 1) {
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      } catch (err) {
        logger.error({ err, accountId: this.accountId }, 'Failed to acquire lock');
      }
    }

    logger.warn({ accountId: this.accountId }, 'Failed to acquire lock after retries');
    return false;
  }

  async release(): Promise<boolean> {
    const redis = getRedis();

    try {
      // Use Lua script to ensure atomic release
      const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;

      const result = await redis.eval(script, 1, this.key, this.value);
      
      if (result === 1) {
        logger.debug({ accountId: this.accountId }, 'Lock released');
        return true;
      }

      logger.warn({ accountId: this.accountId }, 'Lock not released (not owner)');
      return false;
    } catch (err) {
      logger.error({ err, accountId: this.accountId }, 'Failed to release lock');
      return false;
    }
  }

  async extend(additionalTtl?: number): Promise<boolean> {
    const redis = getRedis();
    const newTtl = additionalTtl || this.ttl;

    try {
      const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("expire", KEYS[1], ARGV[2])
        else
          return 0
        end
      `;

      const result = await redis.eval(script, 1, this.key, this.value, newTtl);
      
      if (result === 1) {
        logger.debug({ accountId: this.accountId, ttl: newTtl }, 'Lock extended');
        return true;
      }

      return false;
    } catch (err) {
      logger.error({ err, accountId: this.accountId }, 'Failed to extend lock');
      return false;
    }
  }
}

export async function withAccountLock<T>(
  accountId: string,
  fn: () => Promise<T>,
  options?: LockOptions
): Promise<T> {
  const lock = new Lock(accountId, options);
  const acquired = await lock.acquire();

  if (!acquired) {
    throw new Error(`Failed to acquire lock for account ${accountId}`);
  }

  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

export async function isLocked(accountId: string): Promise<boolean> {
  const redis = getRedis();
  const key = `${LOCK_PREFIX}${accountId}`;
  
  try {
    const exists = await redis.exists(key);
    return exists === 1;
  } catch (err) {
    logger.error({ err, accountId }, 'Failed to check lock status');
    return false;
  }
}

export async function forceReleaseLock(accountId: string): Promise<boolean> {
  const redis = getRedis();
  const key = `${LOCK_PREFIX}${accountId}`;
  
  try {
    const result = await redis.del(key);
    if (result === 1) {
      logger.warn({ accountId }, 'Lock force released');
      return true;
    }
    return false;
  } catch (err) {
    logger.error({ err, accountId }, 'Failed to force release lock');
    return false;
  }
}