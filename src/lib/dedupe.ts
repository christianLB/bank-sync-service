import { getRedis } from './redis';
import { logger } from '../logger';

const DEDUPE_PREFIX = 'gc:tx:dedupe:';
const DEDUPE_TTL = 90 * 24 * 60 * 60; // 90 days

export async function isDuplicate(externalRef: string): Promise<boolean> {
  const redis = getRedis();
  const key = `${DEDUPE_PREFIX}${externalRef}`;
  
  try {
    // SETNX returns 1 if key was set, 0 if it already existed
    const result = await redis.set(key, '1', 'EX', DEDUPE_TTL, 'NX');
    const isDupe = result === null;
    
    if (isDupe) {
      logger.debug({ externalRef }, 'Duplicate transaction detected');
    }
    
    return isDupe;
  } catch (err) {
    logger.error({ err, externalRef }, 'Failed to check duplicate');
    // On error, assume not duplicate to avoid data loss
    return false;
  }
}

export async function markProcessed(externalRef: string): Promise<void> {
  const redis = getRedis();
  const key = `${DEDUPE_PREFIX}${externalRef}`;
  
  try {
    await redis.set(key, '1', 'EX', DEDUPE_TTL);
  } catch (err) {
    logger.error({ err, externalRef }, 'Failed to mark as processed');
  }
}

export async function batchCheckDuplicates(
  externalRefs: string[]
): Promise<Map<string, boolean>> {
  const redis = getRedis();
  const pipeline = redis.pipeline();
  
  const keys = externalRefs.map(ref => `${DEDUPE_PREFIX}${ref}`);
  
  // Check existence of all keys
  keys.forEach(key => pipeline.exists(key));
  
  const results = await pipeline.exec();
  const duplicateMap = new Map<string, boolean>();
  
  if (!results) return duplicateMap;
  
  externalRefs.forEach((ref, index) => {
    const [err, exists] = results[index];
    if (err) {
      logger.error({ err, externalRef: ref }, 'Error checking duplicate');
      duplicateMap.set(ref, false); // Assume not duplicate on error
    } else {
      duplicateMap.set(ref, exists === 1);
    }
  });
  
  return duplicateMap;
}

export async function cleanupOldDedupes(): Promise<number> {
  const redis = getRedis();
  let cleaned = 0;
  
  try {
    const pattern = `${DEDUPE_PREFIX}*`;
    const stream = redis.scanStream({ match: pattern, count: 100 });
    
    stream.on('data', async (keys: string[]) => {
      if (keys.length === 0) return;
      
      const pipeline = redis.pipeline();
      
      for (const key of keys) {
        pipeline.ttl(key);
      }
      
      const ttlResults = await pipeline.exec();
      if (!ttlResults) return;
      
      const deleteKeys: string[] = [];
      ttlResults.forEach((result, index) => {
        const [err, ttl] = result as [Error | null, number | null];
        if (!err && ttl !== null && ttl !== undefined && ttl < 0) {
          deleteKeys.push(keys[index]);
        }
      });
      
      if (deleteKeys.length > 0) {
        await redis.del(...deleteKeys);
        cleaned += deleteKeys.length;
      }
    });
    
    await new Promise((resolve) => stream.on('end', resolve));
    
    logger.info({ cleaned }, 'Cleaned up old dedupe keys');
    return cleaned;
  } catch (err) {
    logger.error({ err }, 'Failed to cleanup dedupes');
    return cleaned;
  }
}