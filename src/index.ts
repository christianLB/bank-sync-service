import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import accounts from './routes/accounts';
import sync from './routes/sync';
import webhook from './routes/webhook-gc';
import auth from './routes/auth';
import requisitions from './routes/requisitions';
import balance from './routes/balance';
import { initRedis, closeRedis } from './lib/redis';
import { getScheduler } from './lib/scheduler';
import { config } from './config';
import { logger } from './logger';

async function bootstrap() {
  // Initialize Redis
  await initRedis();
  logger.info('Redis initialized');

  // Create Fastify instance
  const app = Fastify({
    logger: logger as any,
    requestIdLogLabel: 'reqId',
    disableRequestLogging: false,
    trustProxy: true,
  });

  // Register plugins
  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
  });

  // Health checks
  app.get('/health', async () => ({ ok: true, service: 'bank-sync-service' }));
  app.get('/ready', async () => {
    try {
      const redis = await initRedis();
      await redis.ping();
      return { ok: true, redis: 'connected' };
    } catch (err) {
      logger.error({ err }, 'Readiness check failed');
      throw err;
    }
  });

  // Register routes
  await app.register(auth, { prefix: '/v1' });
  await app.register(requisitions, { prefix: '/v1' });
  await app.register(accounts, { prefix: '/v1' });
  await app.register(balance, { prefix: '/v1' });
  await app.register(sync, { prefix: '/v1' });
  await app.register(webhook, { prefix: '/v1' });

  // Error handler
  app.setErrorHandler((error, request, reply) => {
    logger.error({ 
      err: error,
      reqId: request.id,
      method: request.method,
      url: request.url,
    }, 'Request error');

    const statusCode = error.statusCode || 500;
    reply.status(statusCode).send({
      error: error.name || 'InternalServerError',
      message: error.message || 'An error occurred',
      statusCode,
    });
  });

  // Graceful shutdown
  const signals = ['SIGINT', 'SIGTERM'];
  signals.forEach(signal => {
    process.on(signal, async () => {
      logger.info({ signal }, 'Shutting down gracefully');
      try {
        await scheduler.stop();
        await app.close();
        await closeRedis();
        process.exit(0);
      } catch (err) {
        logger.error({ err }, 'Error during shutdown');
        process.exit(1);
      }
    });
  });

  // Start scheduler
  const scheduler = getScheduler();
  await scheduler.start();
  logger.info('Smart scheduler started');
  
  // Add scheduler status endpoint
  app.get('/v1/scheduler/status', async () => {
    const status = await scheduler.getQueueStatus();
    return status;
  });
  
  // Add endpoint to schedule sync
  app.post('/v1/scheduler/sync/:accountId', async (request: any, reply) => {
    const { accountId } = request.params;
    await scheduler.scheduleBalanceSync(accountId);
    await scheduler.scheduleTransactionSync(accountId);
    return reply.send({ 
      message: 'Sync scheduled',
      accountId 
    });
  });

  // Start server
  try {
    const address = await app.listen({
      port: config.port,
      host: '0.0.0.0',
    });
    logger.info({ address }, 'Server started');
  } catch (err) {
    logger.fatal({ err }, 'Failed to start server');
    process.exit(1);
  }
}

// Start the application
bootstrap().catch(err => {
  logger.fatal({ err }, 'Bootstrap failed');
  process.exit(1);
});