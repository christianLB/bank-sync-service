import { FastifyPluginAsync } from 'fastify';
import { v4 as uuid } from 'uuid';
import { startSync } from '../workers/syncRunner';
import { isLocked } from '../lib/lock';
import { getRedis } from '../lib/redis';
import { logger } from '../logger';
import { SyncOperation } from '../types';

const OPERATION_PREFIX = 'gc:op:';
const OPERATION_TTL = 7 * 24 * 60 * 60; // 7 days

const plugin: FastifyPluginAsync = async (fastify) => {
  fastify.post('/sync/:accountId', {
    schema: {
      params: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
        },
        required: ['accountId'],
      },
      body: {
        type: 'object',
        properties: {
          fromDate: { type: 'string', format: 'date' },
          toDate: { type: 'string', format: 'date' },
        },
      },
      response: {
        202: {
          type: 'object',
          properties: {
            operationId: { type: 'string' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    const body = request.body as { fromDate?: string; toDate?: string };
    
    try {
      // Check if sync is already in progress
      const locked = await isLocked(accountId);
      if (locked) {
        return reply.code(409).send({
          error: 'SYNC_IN_PROGRESS',
          message: 'Sync already in progress for this account',
        });
      }

      // Create operation
      const operationId = uuid();
      const operation: SyncOperation = {
        operationId,
        accountId,
        status: 'pending',
        startedAt: new Date().toISOString(),
        processed: 0,
        errors: [],
      };

      // Store operation
      const redis = getRedis();
      await redis.set(
        `${OPERATION_PREFIX}${operationId}`,
        JSON.stringify(operation),
        'EX',
        OPERATION_TTL
      );

      // Start sync asynchronously
      startSync(accountId, operationId, {
        fromDate: body.fromDate,
        toDate: body.toDate,
      }).catch((err) => {
        logger.error({ err, accountId, operationId }, 'Sync failed');
      });

      return reply.code(202).send({ operationId });
    } catch (err) {
      logger.error({ err, accountId }, 'Failed to start sync');
      return reply.code(500).send({
        error: 'INTERNAL_ERROR',
        message: 'Failed to start sync',
      });
    }
  });

  fastify.get('/operations/:operationId', {
    schema: {
      params: {
        type: 'object',
        properties: {
          operationId: { type: 'string' },
        },
        required: ['operationId'],
      },
    },
  }, async (request, reply) => {
    const { operationId } = request.params as { operationId: string };
    
    try {
      const redis = getRedis();
      const data = await redis.get(`${OPERATION_PREFIX}${operationId}`);
      
      if (!data) {
        return reply.code(404).send({
          error: 'NOT_FOUND',
          message: 'Operation not found',
        });
      }

      const operation = JSON.parse(data) as SyncOperation;
      return operation;
    } catch (err) {
      logger.error({ err, operationId }, 'Failed to get operation');
      return reply.code(500).send({
        error: 'INTERNAL_ERROR',
        message: 'Failed to get operation',
      });
    }
  });
};

export default plugin;