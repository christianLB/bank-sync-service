import { FastifyPluginAsync } from 'fastify';
import { getGCClient } from '../lib/gcClient';
import { getCursor } from '../lib/cursor';
import { getRedis } from '../lib/redis';
import { logger } from '../logger';
import { AccountInfo } from '../types';

const plugin: FastifyPluginAsync = async (fastify) => {
  fastify.get('/accounts', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            accounts: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  provider: { type: 'string' },
                  iban: { type: 'string' },
                  currency: { type: 'string' },
                  balance: { type: 'number' },
                  lastSyncAt: { type: 'string' },
                  status: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  }, async (_request, reply) => {
    try {
      const gcClient = getGCClient();
      const gcAccounts = await gcClient.listAccounts();
      
      const accounts: AccountInfo[] = await Promise.all(
        gcAccounts.map(async (acc) => {
          const cursor = await getCursor(acc.id);
          // Get cached balance (don't make API call)
          const redis = await getRedis();
          const cachedBalance = await redis.get(`balance:${acc.id}`);
          let balance = null;
          if (cachedBalance) {
            const parsed = JSON.parse(cachedBalance);
            balance = parsed.balance;
          }
          
          return {
            id: acc.id,
            name: acc.iban, // Use IBAN as name instead of fetching details
            provider: 'gocardless',
            iban: acc.iban,
            currency: balance?.balanceAmount?.currency || 'EUR',
            balance: balance ? parseFloat(balance.balanceAmount.amount) : undefined,
            lastSyncAt: cursor?.updatedAt,
            status: acc.status === 'READY' ? 'active' : 'inactive' as const,
          };
        })
      );

      return { accounts };
    } catch (err) {
      logger.error({ err }, 'Failed to list accounts');
      return reply.code(500).send({
        error: 'INTERNAL_ERROR',
        message: 'Failed to list accounts',
      });
    }
  });

  fastify.get('/accounts/:accountId', {
    schema: {
      params: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
        },
        required: ['accountId'],
      },
    },
  }, async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    
    try {
      const gcClient = getGCClient();
      const account = await gcClient.getAccount(accountId);
      
      if (!account) {
        return reply.code(404).send({
          error: 'NOT_FOUND',
          message: 'Account not found',
        });
      }

      const cursor = await getCursor(accountId);
      const balance = await gcClient.getBalance(accountId);
      const details = await gcClient.getAccountDetails(accountId);
      
      const accountInfo: AccountInfo = {
        id: account.id,
        name: details?.name || account.iban,
        provider: 'gocardless',
        iban: account.iban,
        currency: details?.currency || balance?.balanceAmount?.currency || 'EUR',
        balance: balance ? parseFloat(balance.balanceAmount.amount) : undefined,
        lastSyncAt: cursor?.updatedAt,
        status: account.status === 'READY' ? 'active' : 'inactive',
      };

      return accountInfo;
    } catch (err) {
      logger.error({ err, accountId }, 'Failed to get account');
      return reply.code(500).send({
        error: 'INTERNAL_ERROR',
        message: 'Failed to get account',
      });
    }
  });
};

export default plugin;