import { Configuration, MessagesApi } from '@k2600x/comm-service-sdk';
import { logger } from '../logger';

let commApi: MessagesApi | null = null;

function getCommApi(): MessagesApi | null {
  if (!process.env.COMM_SERVICE_URL || !process.env.COMM_SERVICE_TOKEN) {
    logger.debug('Comm service not configured, skipping notifications');
    return null;
  }

  if (!commApi) {
    logger.info({ 
      url: process.env.COMM_SERVICE_URL,
      tokenLength: process.env.COMM_SERVICE_TOKEN.length 
    }, 'Initializing comm service API client');
    
    const config = new Configuration({
      basePath: process.env.COMM_SERVICE_URL,
      accessToken: process.env.COMM_SERVICE_TOKEN
    });
    commApi = new MessagesApi(config);
  }

  return commApi;
}

export interface SyncNotificationData {
  accountId: string;
  operationId: string;
  transactionCount?: number;
  fromDate?: string;
  toDate?: string;
  error?: string;
  retryable?: boolean;
}

export async function sendSyncCompleteNotification(data: SyncNotificationData): Promise<void> {
  const api = getCommApi();
  if (!api) return;

  try {
    logger.info({ accountId: data.accountId, operationId: data.operationId }, 'Attempting to send sync complete notification');
    
    await api.v1MessagesSendPost({
      channel: 'telegram',
      template_key: 'sync.complete',
      locale: 'en',
      data: {
        title: 'Bank Sync Complete',
        body: `Successfully synced ${data.transactionCount || 0} transactions for account ${data.accountId}`,
        accountId: data.accountId,
        operationId: data.operationId,
        transactionCount: data.transactionCount || 0,
        fromDate: data.fromDate,
        toDate: data.toDate
      },
      to: {} // Empty - uses admin IDs from comm-service
    });
    
    logger.info({ accountId: data.accountId, operationId: data.operationId }, 'Sync complete notification sent successfully');
  } catch (err: any) {
    logger.error({ err: err.message || err, data }, 'Failed to send sync complete notification');
  }
}

export async function sendSyncFailedNotification(data: SyncNotificationData): Promise<void> {
  const api = getCommApi();
  if (!api) return;

  try {
    await api.v1MessagesSendPost({
      channel: 'telegram',
      template_key: 'sync.failed',
      locale: 'en',
      data: {
        title: 'Bank Sync Failed',
        body: `Sync failed for account ${data.accountId}: ${data.error || 'Unknown error'}`,
        accountId: data.accountId,
        operationId: data.operationId,
        error: data.error,
        retryable: data.retryable || false
      },
      to: {} // Empty - uses admin IDs from comm-service
    });
    
    logger.info({ accountId: data.accountId, operationId: data.operationId }, 'Sync failed notification sent');
  } catch (err) {
    logger.error({ err, data }, 'Failed to send sync failed notification');
  }
}

export async function sendBalanceSyncNotification(data: {
  accountId: string;
  balance?: number;
  currency?: string;
  error?: string;
}): Promise<void> {
  const api = getCommApi();
  if (!api) return;

  try {
    const isError = !!data.error;
    const templateKey = isError ? 'balance.sync.failed' : 'balance.sync.complete';
    
    logger.info({ accountId: data.accountId, isError, templateKey }, 'Attempting to send balance sync notification');
    
    await api.v1MessagesSendPost({
      channel: 'telegram',
      template_key: templateKey,
      locale: 'en',
      data: {
        title: isError ? 'Balance Sync Failed' : 'Balance Updated',
        body: isError 
          ? `Failed to sync balance for account ${data.accountId}: ${data.error}`
          : `Balance updated for account ${data.accountId}: ${data.balance} ${data.currency}`,
        accountId: data.accountId,
        balance: data.balance,
        currency: data.currency,
        error: data.error
      },
      to: {} // Empty - uses admin IDs from comm-service
    });
    
    logger.info({ accountId: data.accountId }, `Balance sync notification sent successfully (${isError ? 'failed' : 'complete'})`);
  } catch (err: any) {
    logger.error({ err: err.message || err, data, url: process.env.COMM_SERVICE_URL }, 'Failed to send balance sync notification');
  }
}