import { FastifyPluginAsync } from 'fastify';
import { getGCClient } from '../lib/gcClient';
import { getRedis } from '../lib/redis';
import { emit } from '../lib/events';
import { logger } from '../logger';
import { WebhookEvent } from '../lib/gcClient';

const WEBHOOK_REPLAY_PREFIX = 'gc:webhook:sig:';
const WEBHOOK_REPLAY_TTL = 72 * 60 * 60; // 72 hours

const plugin: FastifyPluginAsync = async (fastify) => {
  fastify.post('/webhook/gocardless', {
    schema: {
      headers: {
        type: 'object',
        properties: {
          'x-signature': { type: 'string' },
        },
      },
      body: {
        type: 'object',
        properties: {
          events: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                created_at: { type: 'string' },
                resource_type: { type: 'string' },
                action: { type: 'string' },
                links: { type: 'object' },
                details: { type: 'object' },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const signature = request.headers['x-signature'] as string;
    const body = JSON.stringify(request.body);
    
    try {
      // Verify signature
      const gcClient = getGCClient();
      const isValid = gcClient.verifyWebhookSignature(body, signature);
      
      if (!isValid) {
        logger.warn('Invalid webhook signature');
        return reply.code(401).send({
          error: 'INVALID_SIGNATURE',
          message: 'Invalid webhook signature',
        });
      }

      const payload = request.body as { events: WebhookEvent[] };
      const redis = getRedis();
      
      for (const event of payload.events) {
        // Check for replay
        const replayKey = `${WEBHOOK_REPLAY_PREFIX}${event.id}`;
        const alreadyProcessed = await redis.set(
          replayKey,
          '1',
          'EX',
          WEBHOOK_REPLAY_TTL,
          'NX'
        );
        
        if (alreadyProcessed === null) {
          logger.debug({ eventId: event.id }, 'Webhook event already processed');
          continue;
        }

        // Process event based on type
        await processWebhookEvent(event);
      }

      return { status: 'ok' };
    } catch (err) {
      logger.error({ err }, 'Failed to process webhook');
      return reply.code(500).send({
        error: 'INTERNAL_ERROR',
        message: 'Failed to process webhook',
      });
    }
  });
};

async function processWebhookEvent(event: WebhookEvent): Promise<void> {
  logger.info({ 
    eventId: event.id,
    resourceType: event.resource_type,
    action: event.action
  }, 'Processing webhook event');

  try {
    switch (event.resource_type) {
      case 'requisition':
        await handleRequisitionEvent(event);
        break;
      case 'account':
        await handleAccountEvent(event);
        break;
      case 'transaction':
        await handleTransactionEvent(event);
        break;
      default:
        logger.debug({ resourceType: event.resource_type }, 'Unknown resource type');
    }
  } catch (err) {
    logger.error({ err, event }, 'Failed to process webhook event');
    throw err;
  }
}

async function handleRequisitionEvent(event: WebhookEvent): Promise<void> {
  // Handle requisition events (account linking, etc.)
  if (event.action === 'created' || event.action === 'linked') {
    logger.info({ event }, 'Requisition linked');
    // Could trigger initial sync here
  }
}

async function handleAccountEvent(event: WebhookEvent): Promise<void> {
  // Handle account events
  if (event.action === 'updated') {
    const accountId = event.links?.account;
    if (accountId) {
      await emit('bank.account.updated', {
        accountId,
        provider: 'gocardless',
        updatedAt: event.created_at,
      });
    }
  }
}

async function handleTransactionEvent(event: WebhookEvent): Promise<void> {
  // Handle transaction events
  if (event.action === 'created') {
    const transactionId = event.links?.transaction;
    const accountId = event.links?.account;
    
    if (transactionId && accountId) {
      // Could fetch full transaction details and emit event
      logger.info({ transactionId, accountId }, 'New transaction via webhook');
    }
  }
}

export default plugin;