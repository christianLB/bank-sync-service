import pino from 'pino';
import { config } from './config';

const isProduction = config.env === 'production';

export const logger = pino({
  level: config.logLevel,
  transport: isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname',
        },
      },
  serializers: {
    err: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
  formatters: {
    level: (label) => {
      return { level: label };
    },
  },
  base: {
    service: 'bank-sync-service',
    env: config.env,
  },
});