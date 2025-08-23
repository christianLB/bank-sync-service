import { getRedis } from './redis';
import { logger } from '../logger';
import { v4 as uuid } from 'uuid';

export interface EventPayload {
  eventId: string;
  eventType: string;
  timestamp: string;
  version: string;
  data: any;
  metadata?: Record<string, any>;
}

export type EventType = 
  | 'bank.tx.created'
  | 'bank.sync.completed'
  | 'bank.sync.failed'
  | 'bank.account.updated';

const MAX_STREAM_LENGTH = 100000; // Keep last 100k events per stream

export async function emit(
  eventType: EventType,
  data: any,
  metadata?: Record<string, any>
): Promise<string> {
  const redis = getRedis();
  const eventId = uuid();
  
  const event: EventPayload = {
    eventId,
    eventType,
    timestamp: new Date().toISOString(),
    version: '1.0',
    data,
    metadata: metadata || {},
  };

  try {
    // Publish to Redis Stream
    const streamKey = eventType;
    await redis.xadd(
      streamKey,
      'MAXLEN', '~', MAX_STREAM_LENGTH,
      '*',
      'payload', JSON.stringify(event)
    );

    // Also publish to Redis Pub/Sub for real-time consumers
    await redis.publish(eventType, JSON.stringify(event));

    logger.info({ eventType, eventId }, 'Event emitted');
    return eventId;
  } catch (err) {
    logger.error({ err, eventType, eventId }, 'Failed to emit event');
    throw err;
  }
}

export async function getEvents(
  eventType: EventType,
  options: {
    fromId?: string;
    count?: number;
    block?: number;
  } = {}
): Promise<EventPayload[]> {
  const redis = getRedis();
  const fromId = options.fromId || '-';
  const count = options.count || 100;

  try {
    let result: any;
    if (options.block) {
      result = await (redis as any).xread(
        'COUNT', count,
        'BLOCK', options.block,
        'STREAMS', eventType, fromId
      );
    } else {
      result = await (redis as any).xread(
        'COUNT', count,
        'STREAMS', eventType, fromId
      );
    }

    if (!result || result.length === 0) {
      return [];
    }

    const [, messages] = result[0];
    return messages.map(([, fields]: [string, string[]]) => {
      const payload = fields[1]; // fields is ['payload', JSON]
      return JSON.parse(payload) as EventPayload;
    });
  } catch (err) {
    logger.error({ err, eventType }, 'Failed to get events');
    return [];
  }
}

export async function createConsumerGroup(
  eventType: EventType,
  groupName: string,
  fromId: string = '$'
): Promise<void> {
  const redis = getRedis();

  try {
    await redis.xgroup('CREATE', eventType, groupName, fromId, 'MKSTREAM');
    logger.info({ eventType, groupName }, 'Consumer group created');
  } catch (err: any) {
    // Ignore if group already exists
    if (!err.message?.includes('BUSYGROUP')) {
      logger.error({ err, eventType, groupName }, 'Failed to create consumer group');
      throw err;
    }
  }
}

export async function consumeEvents(
  eventType: EventType,
  groupName: string,
  consumerName: string,
  handler: (event: EventPayload) => Promise<void>,
  options: {
    count?: number;
    block?: number;
    autoAck?: boolean;
  } = {}
): Promise<void> {
  const redis = getRedis();
  const count = options.count || 10;
  const block = options.block || 5000;
  const autoAck = options.autoAck !== false;

  while (true) {
    try {
      const result = await redis.xreadgroup(
        'GROUP', groupName, consumerName,
        'COUNT', count,
        'BLOCK', block,
        'STREAMS', eventType, '>'
      ) as any;

      if (!result || result.length === 0) {
        continue;
      }

      const [, messages] = result[0];
      
      for (const [messageId, fields] of messages as any[]) {
        try {
          const payload = JSON.parse(fields[1]) as EventPayload;
          await handler(payload);
          
          if (autoAck) {
            await redis.xack(eventType, groupName, messageId);
          }
        } catch (err) {
          logger.error({ err, messageId, eventType }, 'Failed to process event');
        }
      }
    } catch (err) {
      logger.error({ err, eventType, groupName }, 'Error consuming events');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

export async function getStreamInfo(eventType: EventType): Promise<any> {
  const redis = getRedis();
  
  try {
    const info = await redis.xinfo('STREAM', eventType) as any[];
    return {
      length: info[1],
      firstEntry: info[9],
      lastEntry: info[11],
      groups: info[13],
    };
  } catch (err) {
    logger.error({ err, eventType }, 'Failed to get stream info');
    return null;
  }
}