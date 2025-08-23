import { FastifyPluginAsync } from 'fastify';
import { sendBalanceSyncNotification } from '../lib/notifications';
import { logger } from '../logger';

const plugin: FastifyPluginAsync = async (fastify) => {
  // Test notification endpoint
  fastify.post('/notifications/test', {
    schema: {
      body: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          accountId: { type: 'string', default: 'test-account' }
        }
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            commServiceConfigured: { type: 'boolean' },
            commServiceUrl: { type: 'string' }
          }
        }
      }
    }
  }, async (request, reply) => {
    const { message = 'Test notification from bank sync service', accountId = 'test-account' } = request.body as any;
    
    const commServiceConfigured = !!(process.env.COMM_SERVICE_URL && process.env.COMM_SERVICE_TOKEN);
    
    if (!commServiceConfigured) {
      return reply.send({
        success: false,
        message: 'Comm service not configured (missing COMM_SERVICE_URL or COMM_SERVICE_TOKEN)',
        commServiceConfigured: false,
        commServiceUrl: process.env.COMM_SERVICE_URL || 'not set'
      });
    }
    
    try {
      logger.info({ accountId, message }, 'Testing notification');
      
      await sendBalanceSyncNotification({
        accountId,
        error: message
      });
      
      return reply.send({
        success: true,
        message: 'Test notification sent successfully',
        commServiceConfigured: true,
        commServiceUrl: process.env.COMM_SERVICE_URL
      });
    } catch (error: any) {
      logger.error({ error, accountId }, 'Failed to send test notification');
      
      return reply.code(500).send({
        success: false,
        message: `Failed to send notification: ${error.message}`,
        commServiceConfigured: true,
        commServiceUrl: process.env.COMM_SERVICE_URL
      });
    }
  });

  // Get notification configuration
  fastify.get('/notifications/config', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            configured: { type: 'boolean' },
            url: { type: 'string' },
            hasToken: { type: 'boolean' },
            tokenLength: { type: 'number' }
          }
        }
      }
    }
  }, async (_request, reply) => {
    const hasUrl = !!process.env.COMM_SERVICE_URL;
    const hasToken = !!process.env.COMM_SERVICE_TOKEN;
    
    return reply.send({
      configured: hasUrl && hasToken,
      url: process.env.COMM_SERVICE_URL || 'not set',
      hasToken,
      tokenLength: process.env.COMM_SERVICE_TOKEN?.length || 0
    });
  });
};

export default plugin;