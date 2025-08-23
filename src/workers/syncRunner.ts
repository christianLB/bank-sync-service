import { v4 as uuid } from 'uuid';
import { getCursor, setCursor } from '../lib/cursor';
import { isDuplicate } from '../lib/dedupe';
import { withAccountLock } from '../lib/lock';
import { emit } from '../lib/events';
import { getGCClient } from '../lib/gcClient';
import { getRedis } from '../lib/redis';
import { logger } from '../logger';
import { config } from '../config';
import { BankTransaction, SyncOperation } from '../types';

const OPERATION_PREFIX = 'gc:op:';
const OPERATION_TTL = 7 * 24 * 60 * 60; // 7 days

export interface SyncOptions {
  fromDate?: string;
  toDate?: string;
}

export async function startSync(
  accountId: string,
  operationId: string,
  options: SyncOptions = {}
): Promise<void> {
  
  try {
    // Update operation status
    await updateOperation(operationId, {
      status: 'in_progress',
      startedAt: new Date().toISOString(),
    });

    // Execute sync with lock
    await withAccountLock(
      accountId,
      async () => {
        await executeSyncWithRetry(accountId, operationId, options);
      },
      { ttl: config.sync.lockTtlSeconds }
    );

    // Mark as completed
    await updateOperation(operationId, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });

    // Emit completion event
    const operation = await getOperation(operationId);
    await emit('bank.sync.completed', {
      operationId,
      accountId,
      provider: 'gocardless',
      syncedAt: new Date().toISOString(),
      transactionCount: operation?.processed || 0,
      fromDate: options.fromDate,
      toDate: options.toDate,
    });

    logger.info({ accountId, operationId }, 'Sync completed successfully');
  } catch (err: any) {
    logger.error({ err, accountId, operationId }, 'Sync failed');

    // Update operation with error
    await updateOperation(operationId, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      errors: [err.message || 'Unknown error'],
    });

    // Emit failure event
    await emit('bank.sync.failed', {
      operationId,
      accountId,
      provider: 'gocardless',
      failedAt: new Date().toISOString(),
      error: err.message || 'Unknown error',
      retryable: true,
    });

    throw err;
  }
}

async function executeSyncWithRetry(
  accountId: string,
  operationId: string,
  options: SyncOptions
): Promise<void> {
  const maxRetries = 3;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await executeSync(accountId, operationId, options);
      return;
    } catch (err: any) {
      lastError = err;
      logger.warn({ 
        err, 
        accountId, 
        operationId, 
        attempt 
      }, 'Sync attempt failed');

      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError || new Error('Sync failed after retries');
}

async function executeSync(
  accountId: string,
  operationId: string,
  options: SyncOptions
): Promise<void> {
  const gcClient = getGCClient();
  const cursor = await getCursor(accountId);
  
  // Determine date range
  const fromDate = options.fromDate || 
    cursor?.sinceISO?.split('T')[0] ||
    new Date(Date.now() - config.sync.defaultLookbackDays * 24 * 60 * 60 * 1000)
      .toISOString().split('T')[0];
  
  const toDate = options.toDate || 
    new Date().toISOString().split('T')[0];

  logger.info({ 
    accountId, 
    operationId, 
    fromDate, 
    toDate,
    cursor: cursor?.cursor 
  }, 'Starting sync');

  let processed = 0;

  // Iterate through transaction pages (GoCardless returns all in one call)
  for await (const page of gcClient.listTransactionPages(accountId, {
    date_from: fromDate,
    date_to: toDate,
  })) {
    logger.debug({ 
      accountId, 
      transactions: page.transactions.length,
      next: page.next 
    }, 'Processing transaction page');

    // Process transactions
    for (const gcTx of page.transactions) {
      const normalized = gcClient.normalizeTransaction(gcTx);
      
      // Check for duplicate
      const isDupe = await isDuplicate(normalized.externalRef);
      if (isDupe) {
        logger.debug({ externalRef: normalized.externalRef }, 'Skipping duplicate');
        continue;
      }

      // Create bank transaction
      const bankTx: BankTransaction = {
        txId: uuid(),
        externalRef: normalized.externalRef,
        accountId,
        source: 'bank',
        provider: config.gocardless.provider,
        asset: gcTx.transactionAmount.currency,
        amount: normalized.amount,
        fee: 0,
        direction: normalized.direction,
        bookedAt: gcTx.bookingDate,
        valueDate: gcTx.valueDate,
        description: normalized.description,
        counterparty: normalized.counterparty,
        metadata: {
          bankTransactionCode: gcTx.bankTransactionCode,
          proprietaryCode: gcTx.proprietaryBankTransactionCode,
        },
      };

      // Emit transaction event
      await emit('bank.tx.created', bankTx);
      processed++;

      // Update operation progress
      if (processed % 10 === 0) {
        await updateOperation(operationId, { processed });
      }
    }

    // Update cursor (GoCardless doesn't use cursor for transactions)
    if (page.transactions.length > 0) {
      const lastTx = page.transactions[page.transactions.length - 1];
      await setCursor(accountId, {
        sinceISO: toDate,
        lastTxnRef: lastTx.transactionId,
      });
    }

    // Check max transactions limit
    if (processed >= config.sync.maxTransactionsPerSync) {
      logger.warn({ 
        accountId, 
        processed, 
        max: config.sync.maxTransactionsPerSync 
      }, 'Max transactions reached');
      break;
    }
  }

  // Final cursor update
  await setCursor(accountId, {
    sinceISO: toDate,
  });

  // Final operation update
  await updateOperation(operationId, { 
    processed,
  });

  logger.info({ 
    accountId, 
    operationId, 
    processed 
  }, 'Sync execution completed');
}

async function updateOperation(
  operationId: string,
  updates: Partial<SyncOperation>
): Promise<void> {
  const redis = getRedis();
  const key = `${OPERATION_PREFIX}${operationId}`;
  
  try {
    const existing = await redis.get(key);
    if (!existing) return;

    const operation = JSON.parse(existing) as SyncOperation;
    const updated = { ...operation, ...updates };
    
    await redis.set(key, JSON.stringify(updated), 'EX', OPERATION_TTL);
  } catch (err) {
    logger.error({ err, operationId }, 'Failed to update operation');
  }
}

async function getOperation(operationId: string): Promise<SyncOperation | null> {
  const redis = getRedis();
  const key = `${OPERATION_PREFIX}${operationId}`;
  
  try {
    const data = await redis.get(key);
    return data ? JSON.parse(data) as SyncOperation : null;
  } catch (err) {
    logger.error({ err, operationId }, 'Failed to get operation');
    return null;
  }
}