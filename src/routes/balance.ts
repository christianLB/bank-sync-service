import { FastifyPluginAsync } from 'fastify';
import { getGCClient } from '../lib/gcClient';
import { getRequisitionManager } from '../lib/requisition';
import { getRedis } from '../lib/redis';
import { logger } from '../logger';

const BALANCE_CACHE_TTL = 3600; // 1 hour cache
const RATE_LIMIT_KEY = 'gc:ratelimit:';
const DAILY_LIMIT_KEY = 'gc:daily:';
const DAILY_LIMIT = 4; // GoCardless actual limit for balance endpoint

const plugin: FastifyPluginAsync = async (fastify) => {
  // Get balance for a specific account
  fastify.get<{
    Params: { accountId: string };
  }>('/accounts/:accountId/balance', {
    schema: {
      params: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
        },
        required: ['accountId'],
      },
      response: {
        200: {
          type: 'object',
          properties: {
            balance: {
              type: 'object',
              properties: {
                balanceAmount: {
                  type: 'object',
                  properties: {
                    amount: { type: 'string' },
                    currency: { type: 'string' },
                  },
                },
                balanceType: { type: 'string' },
                referenceDate: { type: 'string' },
              },
            },
            cached: { type: 'boolean' },
            nextSyncAvailable: { type: 'string' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { accountId } = request.params;
    const redis = await getRedis();

    try {
      // Check if we're rate limited
      const rateLimitKey = `${RATE_LIMIT_KEY}${accountId}`;
      const rateLimitExpiry = await redis.get(rateLimitKey);
      
      if (rateLimitExpiry) {
        const expiryTime = new Date(parseInt(rateLimitExpiry));
        logger.warn({ accountId, expiryTime }, 'Account is rate limited');
        
        // Return cached balance if available
        const cachedBalance = await redis.get(`balance:${accountId}`);
        if (cachedBalance) {
          return reply.send({
            ...JSON.parse(cachedBalance),
            cached: true,
            nextSyncAvailable: expiryTime.toISOString(),
          });
        }
        
        return reply.code(429).send({
          error: 'RATE_LIMITED',
          message: `Rate limit exceeded. Next sync available at ${expiryTime.toISOString()}`,
          nextSyncAvailable: expiryTime.toISOString(),
        });
      }

      // Check daily limit
      const dailyKey = `${DAILY_LIMIT_KEY}${accountId}:${new Date().toISOString().split('T')[0]}`;
      const dailyCount = await redis.get(dailyKey);
      
      if (dailyCount && parseInt(dailyCount) >= DAILY_LIMIT) {
        logger.warn({ accountId, dailyCount }, 'Daily limit reached for account');
        
        // Return cached balance
        const cachedBalance = await redis.get(`balance:${accountId}`);
        if (cachedBalance) {
          return reply.send({
            ...JSON.parse(cachedBalance),
            cached: true,
            nextSyncAvailable: new Date(new Date().setHours(24, 0, 0, 0)).toISOString(),
          });
        }
        
        return reply.code(429).send({
          error: 'DAILY_LIMIT_EXCEEDED',
          message: 'Daily request limit (10) has been exceeded',
          nextSyncAvailable: new Date(new Date().setHours(24, 0, 0, 0)).toISOString(),
        });
      }

      // Check cached balance first
      const cacheKey = `balance:${accountId}`;
      const cached = await redis.get(cacheKey);
      
      if (cached) {
        const cacheData = JSON.parse(cached);
        const cacheAge = Date.now() - cacheData.timestamp;
        
        // Return cached data if fresh enough (1 hour)
        if (cacheAge < BALANCE_CACHE_TTL * 1000) {
          return reply.send({
            balance: cacheData.balance,
            cached: true,
            nextSyncAvailable: new Date(cacheData.timestamp + BALANCE_CACHE_TTL * 1000).toISOString(),
          });
        }
      }

      // Fetch fresh balance from GoCardless
      const gcClient = getGCClient();
      
      try {
        const balanceData = await gcClient.getBalance(accountId);
        
        // Cache the balance
        if (balanceData) {
          await redis.setex(
            cacheKey,
            BALANCE_CACHE_TTL,
            JSON.stringify({
              balance: balanceData,
              timestamp: Date.now(),
            })
          );
        }
        
        // Update daily count
        await redis.incr(dailyKey);
        await redis.expire(dailyKey, 86400); // Expire at midnight
        
        logger.info({ accountId }, 'Balance fetched successfully');
        
        return reply.send({
          balance: balanceData,
          cached: false,
        });
        
      } catch (error: any) {
        // Handle rate limit error from GoCardless
        if (error.response?.status === 429) {
          const retryAfter = error.response.headers['retry-after'] || 
                            error.response.headers['x-ratelimit-account-success-reset'] || 
                            '3600';
          
          const retryTime = Date.now() + (parseInt(retryAfter) * 1000);
          
          // Store rate limit expiry
          await redis.setex(rateLimitKey, parseInt(retryAfter), retryTime.toString());
          
          logger.error({ 
            accountId, 
            retryAfter,
            message: error.response?.data?.detail || 'Rate limit exceeded'
          }, 'GoCardless rate limit hit');
          
          // Return cached data if available
          if (cached) {
            const cacheData = JSON.parse(cached);
            return reply.send({
              balance: cacheData.balance,
              cached: true,
              nextSyncAvailable: new Date(retryTime).toISOString(),
            });
          }
          
          return reply.code(429).send({
            error: 'GOCARDLESS_RATE_LIMIT',
            message: error.response?.data?.detail || 'Rate limit exceeded',
            nextSyncAvailable: new Date(retryTime).toISOString(),
          });
        }
        
        throw error;
      }
      
    } catch (error) {
      logger.error({ error, accountId }, 'Failed to get balance');
      return reply.code(500).send({
        error: 'INTERNAL_ERROR',
        message: 'Failed to get balance',
      });
    }
  });

  // Sync all account balances with smart scheduling
  fastify.post('/sync/balances', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            synced: { type: 'number' },
            cached: { type: 'number' },
            rateLimited: { type: 'number' },
            results: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  accountId: { type: 'string' },
                  status: { type: 'string' },
                  balance: { type: 'string' },
                  currency: { type: 'string' },
                  cached: { type: 'boolean' },
                  nextSync: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  }, async (_request, reply) => {
    const redis = await getRedis();
    const gcClient = getGCClient();
    
    try {
      // Get all requisitions to find accounts
      const reqManager = getRequisitionManager();
      const reqData = await reqManager.listRequisitions();
      const requisitions = reqData.results;
      const accounts: string[] = [];
      
      for (const req of requisitions) {
        if (req.status === 'LN' && req.accounts) {
          accounts.push(...req.accounts);
        }
      }
      
      // Remove duplicates
      const uniqueAccounts = [...new Set(accounts)];
      
      const results = [];
      let synced = 0;
      let cached = 0;
      let rateLimited = 0;
      
      for (const accountId of uniqueAccounts) {
        // Check rate limits
        const rateLimitKey = `${RATE_LIMIT_KEY}${accountId}`;
        const dailyKey = `${DAILY_LIMIT_KEY}${accountId}:${new Date().toISOString().split('T')[0]}`;
        
        const isRateLimited = await redis.get(rateLimitKey);
        const dailyCount = await redis.get(dailyKey);
        
        if (isRateLimited || (dailyCount && parseInt(dailyCount) >= 10)) {
          // Return cached data
          const cachedBalance = await redis.get(`balance:${accountId}`);
          if (cachedBalance) {
            const data = JSON.parse(cachedBalance);
            results.push({
              accountId,
              status: 'cached',
              balance: data.balance?.balanceAmount?.amount || '0',
              currency: data.balance?.balanceAmount?.currency || 'EUR',
              cached: true,
              nextSync: isRateLimited 
                ? new Date(parseInt(isRateLimited)).toISOString()
                : new Date(new Date().setHours(24, 0, 0, 0)).toISOString(),
            });
            cached++;
          } else {
            results.push({
              accountId,
              status: 'rate_limited',
              cached: false,
              nextSync: isRateLimited 
                ? new Date(parseInt(isRateLimited)).toISOString()
                : new Date(new Date().setHours(24, 0, 0, 0)).toISOString(),
            });
            rateLimited++;
          }
          continue;
        }
        
        // Try to sync
        try {
          const balanceData = await gcClient.getBalance(accountId);
          
          // Cache the result
          if (balanceData) {
            await redis.setex(
              `balance:${accountId}`,
              BALANCE_CACHE_TTL,
              JSON.stringify({
                balance: balanceData,
                timestamp: Date.now(),
              })
            );
          }
          
          // Update daily count
          await redis.incr(dailyKey);
          await redis.expire(dailyKey, 86400);
          
          results.push({
            accountId,
            status: 'synced',
            balance: balanceData?.balanceAmount?.amount || '0',
            currency: balanceData?.balanceAmount?.currency || 'EUR',
            cached: false,
            nextSync: new Date(Date.now() + BALANCE_CACHE_TTL * 1000).toISOString(),
          });
          synced++;
          
          // Add delay to avoid hitting rate limits
          await new Promise(resolve => setTimeout(resolve, 1000));
          
        } catch (error: any) {
          if (error.response?.status === 429) {
            const retryAfter = error.response.headers['retry-after'] || '3600';
            await redis.setex(rateLimitKey, parseInt(retryAfter), (Date.now() + parseInt(retryAfter) * 1000).toString());
            
            results.push({
              accountId,
              status: 'rate_limited',
              cached: false,
              nextSync: new Date(Date.now() + parseInt(retryAfter) * 1000).toISOString(),
            });
            rateLimited++;
          } else {
            results.push({
              accountId,
              status: 'error',
              error: error.message,
              cached: false,
            });
          }
        }
      }
      
      return reply.send({
        synced,
        cached,
        rateLimited,
        results,
      });
      
    } catch (error) {
      logger.error({ error }, 'Failed to sync balances');
      return reply.code(500).send({
        error: 'SYNC_FAILED',
        message: 'Failed to sync account balances',
      });
    }
  });

  // Get rate limit status for all accounts
  fastify.get('/sync/limits', async (_request, reply) => {
    const redis = await getRedis();
    
    try {
      const reqManager = getRequisitionManager();
      const reqData = await reqManager.listRequisitions();
      const requisitions = reqData.results;
      const accounts: string[] = [];
      
      for (const req of requisitions) {
        if (req.status === 'LN' && req.accounts) {
          accounts.push(...req.accounts);
        }
      }
      
      const uniqueAccounts = [...new Set(accounts)];
      const today = new Date().toISOString().split('T')[0];
      
      const limits = await Promise.all(
        uniqueAccounts.map(async (accountId) => {
          const rateLimitKey = `${RATE_LIMIT_KEY}${accountId}`;
          const dailyKey = `${DAILY_LIMIT_KEY}${accountId}:${today}`;
          
          const rateLimitExpiry = await redis.get(rateLimitKey);
          const dailyCount = await redis.get(dailyKey);
          
          return {
            accountId,
            dailyUsed: parseInt(dailyCount || '0'),
            dailyLimit: DAILY_LIMIT,
            dailyRemaining: Math.max(0, DAILY_LIMIT - parseInt(dailyCount || '0')),
            rateLimited: !!rateLimitExpiry,
            rateLimitExpiry: rateLimitExpiry ? new Date(parseInt(rateLimitExpiry)).toISOString() : null,
            nextResetTime: new Date(new Date().setHours(24, 0, 0, 0)).toISOString(),
          };
        })
      );
      
      return reply.send({
        date: today,
        accounts: limits,
        summary: {
          total: limits.length,
          rateLimited: limits.filter(l => l.rateLimited).length,
          dailyLimitReached: limits.filter(l => l.dailyRemaining <= 0).length,
        },
      });
      
    } catch (error) {
      logger.error({ error }, 'Failed to get rate limits');
      return reply.code(500).send({
        error: 'INTERNAL_ERROR',
        message: 'Failed to get rate limit status',
      });
    }
  });
};

export default plugin;