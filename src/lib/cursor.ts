import { getRedis } from './redis';
import { logger } from '../logger';

export interface CursorData {
  sinceISO: string;
  cursor?: string;
  lastTxnRef?: string;
  updatedAt: string;
}

const CURSOR_PREFIX = 'gc:cursor:';
const CHECKPOINT_PREFIX = 'gc:checkpoint:';

export async function getCursor(accountId: string): Promise<CursorData | null> {
  const redis = getRedis();
  const key = `${CURSOR_PREFIX}${accountId}`;
  
  try {
    const data = await redis.get(key);
    if (!data) return null;
    
    return JSON.parse(data) as CursorData;
  } catch (err) {
    logger.error({ err, accountId }, 'Failed to get cursor');
    return null;
  }
}

export async function setCursor(
  accountId: string,
  cursor: Partial<CursorData>
): Promise<void> {
  const redis = getRedis();
  const key = `${CURSOR_PREFIX}${accountId}`;
  
  try {
    const existing = await getCursor(accountId);
    const updated: CursorData = {
      sinceISO: cursor.sinceISO || existing?.sinceISO || new Date().toISOString(),
      cursor: cursor.cursor || existing?.cursor,
      lastTxnRef: cursor.lastTxnRef || existing?.lastTxnRef,
      updatedAt: new Date().toISOString(),
    };
    
    await redis.set(key, JSON.stringify(updated));
    
    // Optional: Save checkpoint to durable storage
    await saveCheckpoint(accountId, updated);
    
    logger.debug({ accountId, cursor: updated }, 'Cursor updated');
  } catch (err) {
    logger.error({ err, accountId }, 'Failed to set cursor');
    throw err;
  }
}

async function saveCheckpoint(accountId: string, cursor: CursorData): Promise<void> {
  const redis = getRedis();
  const key = `${CHECKPOINT_PREFIX}${accountId}`;
  
  // Save with longer TTL as backup
  await redis.set(key, JSON.stringify(cursor), 'EX', 30 * 24 * 60 * 60); // 30 days
}

export async function restoreFromCheckpoint(accountId: string): Promise<CursorData | null> {
  const redis = getRedis();
  const key = `${CHECKPOINT_PREFIX}${accountId}`;
  
  try {
    const data = await redis.get(key);
    if (!data) return null;
    
    const checkpoint = JSON.parse(data) as CursorData;
    await setCursor(accountId, checkpoint);
    
    logger.info({ accountId, checkpoint }, 'Restored from checkpoint');
    return checkpoint;
  } catch (err) {
    logger.error({ err, accountId }, 'Failed to restore checkpoint');
    return null;
  }
}