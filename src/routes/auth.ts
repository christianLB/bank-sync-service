import { FastifyPluginAsync } from 'fastify';
import { getGCAuth } from '../lib/gcAuth';
import { logger } from '../logger';

const plugin: FastifyPluginAsync = async (fastify) => {
  // Generate or refresh token
  fastify.post('/auth/token', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            message: { type: 'string' },
            hasToken: { type: 'boolean' },
          },
        },
      },
    },
  }, async (_request, reply) => {
    try {
      const auth = getGCAuth();
      const token = await auth.getAccessToken();
      
      return {
        status: 'success',
        message: 'Token generated successfully',
        hasToken: !!token,
      };
    } catch (err) {
      logger.error({ err }, 'Failed to generate token');
      return reply.code(500).send({
        error: 'TOKEN_GENERATION_FAILED',
        message: 'Failed to generate access token',
      });
    }
  });

  // Check token status
  fastify.get('/auth/status', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            hasValidToken: { type: 'boolean' },
            provider: { type: 'string' },
          },
        },
      },
    },
  }, async (_request, reply) => {
    try {
      const auth = getGCAuth();
      const hasValidToken = await auth.hasValidToken();
      
      return {
        hasValidToken,
        provider: 'gocardless',
      };
    } catch (err) {
      logger.error({ err }, 'Failed to check token status');
      return reply.code(500).send({
        error: 'STATUS_CHECK_FAILED',
        message: 'Failed to check token status',
      });
    }
  });

  // Clear tokens (logout)
  fastify.post('/auth/logout', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (_request, reply) => {
    try {
      const auth = getGCAuth();
      await auth.clearTokens();
      
      return {
        status: 'success',
        message: 'Tokens cleared successfully',
      };
    } catch (err) {
      logger.error({ err }, 'Failed to clear tokens');
      return reply.code(500).send({
        error: 'LOGOUT_FAILED',
        message: 'Failed to clear tokens',
      });
    }
  });

  // Temporary test endpoint for notifications
  fastify.post('/notifications/test', async () => {
    return { 
      success: true,
      message: 'Test endpoint working from auth route',
      timestamp: new Date().toISOString()
    };
  });
};

export default plugin;