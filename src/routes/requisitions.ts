import { FastifyPluginAsync } from 'fastify';
import { getRequisitionManager } from '../lib/requisition';
import { logger } from '../logger';
import { config } from '../config';

const plugin: FastifyPluginAsync = async (fastify) => {
  // List available institutions
  fastify.get('/institutions', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          country: { type: 'string', minLength: 2, maxLength: 2 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            institutions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  bic: { type: 'string' },
                  transaction_total_days: { type: 'string' },
                  countries: { type: 'array', items: { type: 'string' } },
                  logo: { type: 'string' },
                },
              },
            },
            count: { type: 'number' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { country } = request.query as { country?: string };
    const countryCode = country || config.gocardless.countryCode;
    
    try {
      const manager = getRequisitionManager();
      const institutions = await manager.listInstitutions(countryCode);
      
      return {
        institutions,
        count: institutions.length,
      };
    } catch (err) {
      logger.error({ err, countryCode }, 'Failed to list institutions');
      return reply.code(500).send({
        error: 'LIST_INSTITUTIONS_FAILED',
        message: 'Failed to list institutions',
      });
    }
  });

  // Create a new requisition
  fastify.post('/requisitions', {
    schema: {
      body: {
        type: 'object',
        required: ['institutionId'],
        properties: {
          institutionId: { type: 'string' },
          redirectUrl: { type: 'string' },
          reference: { type: 'string' },
          userLanguage: { type: 'string' },
          maxHistoricalDays: { type: 'number' },
          accessValidForDays: { type: 'number' },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            link: { type: 'string' },
            status: { type: 'string' },
            institutionId: { type: 'string' },
            reference: { type: 'string' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as {
      institutionId: string;
      redirectUrl?: string;
      reference?: string;
      userLanguage?: string;
      maxHistoricalDays?: number;
      accessValidForDays?: number;
    };
    
    try {
      const manager = getRequisitionManager();
      
      // Create agreement if custom parameters provided
      let agreementId: string | undefined;
      if (body.maxHistoricalDays || body.accessValidForDays) {
        const agreement = await manager.createAgreement(
          body.institutionId,
          body.maxHistoricalDays,
          body.accessValidForDays
        );
        agreementId = agreement.id;
      }
      
      const requisition = await manager.createRequisition(
        body.institutionId,
        body.redirectUrl || config.gocardless.redirectUrl,
        agreementId,
        body.reference,
        body.userLanguage
      );
      
      return reply.code(201).send({
        id: requisition.id,
        link: requisition.link,
        status: requisition.status,
        institutionId: requisition.institution_id,
        reference: requisition.reference,
      });
    } catch (err) {
      logger.error({ err, body }, 'Failed to create requisition');
      return reply.code(500).send({
        error: 'CREATE_REQUISITION_FAILED',
        message: 'Failed to create requisition',
      });
    }
  });

  // Get requisition status
  fastify.get('/requisitions/:id', {
    schema: {
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
      response: {
        200: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            status: { type: 'string' },
            statusDescription: { type: 'string' },
            accounts: { type: 'array', items: { type: 'string' } },
            institutionId: { type: 'string' },
            created: { type: 'string' },
            link: { type: 'string' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    
    try {
      const manager = getRequisitionManager();
      const requisition = await manager.getRequisition(id);
      
      if (!requisition) {
        return reply.code(404).send({
          error: 'NOT_FOUND',
          message: 'Requisition not found',
        });
      }
      
      return {
        id: requisition.id,
        status: requisition.status,
        statusDescription: manager.getStatusDescription(requisition.status as any),
        accounts: requisition.accounts || [],
        institutionId: requisition.institution_id,
        created: requisition.created,
        link: requisition.link,
      };
    } catch (err) {
      logger.error({ err, id }, 'Failed to get requisition');
      return reply.code(500).send({
        error: 'GET_REQUISITION_FAILED',
        message: 'Failed to get requisition',
      });
    }
  });

  // Delete a requisition
  fastify.delete('/requisitions/:id', {
    schema: {
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
      response: {
        204: {
          type: 'null',
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    
    try {
      const manager = getRequisitionManager();
      await manager.deleteRequisition(id);
      
      return reply.code(204).send();
    } catch (err) {
      logger.error({ err, id }, 'Failed to delete requisition');
      return reply.code(500).send({
        error: 'DELETE_REQUISITION_FAILED',
        message: 'Failed to delete requisition',
      });
    }
  });

  // Handle requisition callback (after bank authorization)
  fastify.get('/requisitions/callback', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          error: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { ref, error } = request.query as { ref?: string; error?: string };
    
    if (error) {
      logger.error({ error, ref }, 'Requisition callback error');
      return reply.type('text/html').send(`
        <html>
          <body>
            <h1>Authorization Failed</h1>
            <p>Error: ${error}</p>
            <p>Please try again or contact support.</p>
          </body>
        </html>
      `);
    }
    
    if (!ref) {
      return reply.type('text/html').send(`
        <html>
          <body>
            <h1>Invalid Callback</h1>
            <p>Missing reference parameter.</p>
          </body>
        </html>
      `);
    }
    
    try {
      // In production, you might want to redirect to your frontend app
      // For now, we'll just show a success message
      logger.info({ ref }, 'Requisition callback received');
      
      return reply.type('text/html').send(`
        <html>
          <body>
            <h1>Authorization Successful</h1>
            <p>Your bank account has been successfully linked.</p>
            <p>Reference: ${ref}</p>
            <p>You can now close this window and return to the application.</p>
          </body>
        </html>
      `);
    } catch (err) {
      logger.error({ err, ref }, 'Failed to handle callback');
      return reply.type('text/html').send(`
        <html>
          <body>
            <h1>Error</h1>
            <p>An error occurred while processing your authorization.</p>
            <p>Please try again or contact support.</p>
          </body>
        </html>
      `);
    }
  });

  // List all requisitions
  fastify.get('/requisitions', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'number', default: 100 },
          offset: { type: 'number', default: 0 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            count: { type: 'number' },
            next: { type: ['string', 'null'] },
            previous: { type: ['string', 'null'] },
            results: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  status: { type: 'string' },
                  institutionId: { type: 'string' },
                  created: { type: 'string' },
                  accounts: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { limit, offset } = request.query as { limit?: number; offset?: number };
    
    try {
      const manager = getRequisitionManager();
      const result = await manager.listRequisitions(limit || 100, offset || 0);
      
      return {
        count: result.count,
        next: result.next,
        previous: result.previous,
        results: result.results.map(r => ({
          id: r.id,
          status: r.status,
          institutionId: r.institution_id,
          created: r.created,
          accounts: r.accounts || [],
        })),
      };
    } catch (err) {
      logger.error({ err }, 'Failed to list requisitions');
      return reply.code(500).send({
        error: 'LIST_REQUISITIONS_FAILED',
        message: 'Failed to list requisitions',
      });
    }
  });

  // Clean up duplicate requisitions
  fastify.post('/requisitions/cleanup', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            cleaned: { type: 'number' },
            kept: { type: 'number' },
            message: { type: 'string' }
          }
        }
      }
    }
  }, async (_request, reply) => {
    try {
      const manager = getRequisitionManager();
      const requisitions = await manager.listRequisitions();
      
      // Group by accounts (same account IDs = duplicates)
      const groups = new Map<string, typeof requisitions.results>();
      
      for (const req of requisitions.results) {
        if (req.status === 'LN') {
          const key = req.accounts.sort().join(',');
          if (!groups.has(key)) {
            groups.set(key, []);
          }
          groups.get(key)!.push(req);
        }
      }
      
      let cleaned = 0;
      let kept = 0;
      
      // Keep only the newest requisition in each group
      for (const [, group] of groups) {
        if (group.length > 1) {
          // Sort by creation date, keep newest
          group.sort((a: any, b: any) => new Date(b.created).getTime() - new Date(a.created).getTime());
          const toKeep = group[0];
          const toDelete = group.slice(1);
          
          kept++;
          
          // Delete the duplicates
          const manager = getRequisitionManager();
          for (const req of toDelete) {
            try {
              await manager.deleteRequisition(req.id);
              cleaned++;
              logger.info({ requisitionId: req.id, created: req.created }, 'Deleted duplicate requisition');
            } catch (err) {
              logger.error({ err, requisitionId: req.id }, 'Failed to delete duplicate requisition');
            }
          }
          
          logger.info({ 
            kept: toKeep.id, 
            deleted: toDelete.length,
            accounts: toKeep.accounts 
          }, 'Cleaned up duplicate requisitions for account group');
        } else {
          kept++;
        }
      }
      
      return {
        cleaned,
        kept,
        message: `Cleaned up ${cleaned} duplicate requisitions, kept ${kept} unique ones`
      };
      
    } catch (err) {
      logger.error({ err }, 'Failed to clean up requisitions');
      return reply.code(500).send({
        error: 'CLEANUP_FAILED',
        message: 'Failed to clean up duplicate requisitions',
      });
    }
  });
};

export default plugin;