import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const configSchema = z.object({
  env: z.enum(['development', 'production', 'test']).default('development'),
  port: z.number().default(3000),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  
  redis: z.object({
    url: z.string().default('redis://localhost:6379'),
  }),
  
  database: z.object({
    url: z.string().optional(),
  }),
  
  gocardless: z.object({
    baseUrl: z.string().default('https://bankaccountdata.gocardless.com'),
    secretId: z.string(),
    secretKey: z.string(),
    webhookSecret: z.string().optional(),
    provider: z.string().default('gocardless'),
    redirectUrl: z.string(),
    countryCode: z.string().default('ES'),
  }),
  
  sync: z.object({
    defaultLookbackDays: z.number().default(90),
    maxTransactionsPerSync: z.number().default(1000),
    lockTtlSeconds: z.number().default(900), // 15 minutes
  }),
});

export type Config = z.infer<typeof configSchema>;

const rawConfig = {
  env: process.env.NODE_ENV,
  port: Number(process.env.PORT) || 3000,
  logLevel: process.env.LOG_LEVEL,
  
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },
  
  database: {
    url: process.env.DB_URL,
  },
  
  gocardless: {
    baseUrl: process.env.GC_BASE_URL || 'https://bankaccountdata.gocardless.com',
    secretId: process.env.GC_SECRET_ID || '',
    secretKey: process.env.GC_SECRET_KEY || '',
    webhookSecret: process.env.GC_WEBHOOK_SECRET,
    provider: process.env.GC_PROVIDER || 'gocardless',
    redirectUrl: process.env.GC_REDIRECT_URL || 'http://localhost:4010/v1/requisitions/callback',
    countryCode: process.env.GC_COUNTRY_CODE || 'ES',
  },
  
  sync: {
    defaultLookbackDays: Number(process.env.SYNC_LOOKBACK_DAYS) || 90,
    maxTransactionsPerSync: Number(process.env.MAX_TRANSACTIONS_PER_SYNC) || 1000,
    lockTtlSeconds: Number(process.env.LOCK_TTL_SECONDS) || 900,
  },
};

export const config = configSchema.parse(rawConfig);