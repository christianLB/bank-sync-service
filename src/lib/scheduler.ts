import { getRedis } from './redis';
import { getGCClient } from './gcClient';
import { getRequisitionManager } from './requisition';
import { logger } from '../logger';
import { EventEmitter } from 'events';

export interface ScheduledTask {
  id: string;
  type: 'balance' | 'transactions' | 'details';
  accountId: string;
  priority: number;
  retryCount: number;
  nextRunTime: Date;
  lastError?: string;
}

export class SmartScheduler extends EventEmitter {
  private isRunning = false;
  private queue: ScheduledTask[] = [];
  private intervalId?: NodeJS.Timeout;
  private lastDailyCheck?: Date;
  
  // Rate limit tracking
  private readonly DAILY_LIMIT = 4; // GoCardless actual limit for balance endpoint
  private readonly MAX_REQUESTS_PER_MINUTE = 100; // Global rate limit
  
  constructor() {
    super();
  }

  async start() {
    if (this.isRunning) {
      logger.warn('Scheduler already running');
      return;
    }
    
    this.isRunning = true;
    logger.info('Smart scheduler started');
    
    // Load pending tasks from Redis
    await this.loadPendingTasks();
    
    // Schedule periodic checks every 30 seconds
    this.intervalId = setInterval(async () => {
      try {
        await this.processTasks();
        
        // Check if we need to schedule daily syncs (every 30 minutes)
        const now = new Date();
        if (!this.lastDailyCheck || (now.getTime() - this.lastDailyCheck.getTime()) > 30 * 60 * 1000) {
          await this.scheduleDailySyncs();
          this.lastDailyCheck = now;
        }
      } catch (err) {
        logger.error({ err }, 'Error processing scheduled tasks');
      }
    }, 30000);
    
    // Schedule daily syncs for all accounts
    await this.scheduleDailySyncs();
    
    // Process immediately
    await this.processTasks();
  }

  async stop() {
    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    logger.info('Smart scheduler stopped');
  }

  async scheduleBalanceSync(accountId: string, priority = 5) {
    const task: ScheduledTask = {
      id: `balance:${accountId}:${Date.now()}`,
      type: 'balance',
      accountId,
      priority,
      retryCount: 0,
      nextRunTime: new Date(),
    };
    
    await this.addTask(task);
  }

  async scheduleTransactionSync(accountId: string, priority = 3) {
    const task: ScheduledTask = {
      id: `transactions:${accountId}:${Date.now()}`,
      type: 'transactions',
      accountId,
      priority,
      retryCount: 0,
      nextRunTime: new Date(),
    };
    
    await this.addTask(task);
  }

  async scheduleDailySyncs() {
    const redis = await getRedis();
    
    try {
      // Get all account IDs from requisitions
      const { getGCClient } = await import('./gcClient');
      const gcClient = getGCClient();
      const requisitions = await gcClient.listRequisitions();
      
      // Get all unique account IDs from active requisitions
      const accountIds = new Set<string>();
      for (const req of requisitions.results) {
        if (req.status === 'LN') { // Only linked requisitions
          req.accounts.forEach(accountId => accountIds.add(accountId));
        }
      }
      
      logger.info({ accountCount: accountIds.size }, 'Scheduling daily syncs for all accounts');
      
      // Schedule both balance and transaction syncs for each account
      for (const accountId of accountIds) {
        // Check if we already have syncs scheduled for today
        const today = new Date().toISOString().split('T')[0];
        const balanceKey = `daily:balance:${accountId}:${today}`;
        const transactionKey = `daily:transaction:${accountId}:${today}`;
        
        const balanceScheduled = await redis.get(balanceKey);
        const transactionScheduled = await redis.get(transactionKey);
        
        if (!balanceScheduled) {
          await this.scheduleBalanceSync(accountId, 5);
          await redis.setex(balanceKey, 86400, '1'); // Mark as scheduled for today
          logger.info({ accountId }, 'Scheduled daily balance sync');
        }
        
        if (!transactionScheduled) {
          await this.scheduleTransactionSync(accountId, 3);
          await redis.setex(transactionKey, 86400, '1'); // Mark as scheduled for today
          logger.info({ accountId }, 'Scheduled daily transaction sync');
        }
      }
      
    } catch (err) {
      logger.error({ err }, 'Failed to schedule daily syncs');
    }
  }

  private async addTask(task: ScheduledTask) {
    const redis = await getRedis();
    
    // Check if we can run this task
    const canRun = await this.canRunTask(task);
    
    if (!canRun.allowed) {
      // Schedule for later
      task.nextRunTime = canRun.nextAvailableTime || new Date(Date.now() + 3600000);
      logger.info({ task, nextRun: task.nextRunTime }, 'Task scheduled for later due to rate limits');
    }
    
    // Store in Redis
    await redis.zadd(
      'scheduler:queue',
      task.nextRunTime.getTime(),
      JSON.stringify(task)
    );
    
    this.queue.push(task);
    this.queue.sort((a, b) => a.nextRunTime.getTime() - b.nextRunTime.getTime());
    
    this.emit('taskScheduled', task);
  }

  private async canRunTask(task: ScheduledTask): Promise<{ allowed: boolean; nextAvailableTime?: Date; reason?: string }> {
    const redis = await getRedis();
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    
    // Check if account is rate limited
    const rateLimitKey = `gc:ratelimit:${task.accountId}`;
    const rateLimitExpiry = await redis.get(rateLimitKey);
    
    if (rateLimitExpiry) {
      const expiryTime = new Date(parseInt(rateLimitExpiry));
      if (expiryTime > now) {
        return {
          allowed: false,
          nextAvailableTime: expiryTime,
          reason: 'Account is rate limited by GoCardless',
        };
      }
    }
    
    // Check daily limit
    const dailyKey = `gc:daily:${task.accountId}:${today}`;
    const dailyCount = await redis.get(dailyKey);
    
    if (dailyCount && parseInt(dailyCount) >= this.DAILY_LIMIT) {
      // Calculate next day reset time
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(0, 0, 0, 0);
      
      return {
        allowed: false,
        nextAvailableTime: tomorrow,
        reason: `Daily limit (${this.DAILY_LIMIT}) reached for account`,
      };
    }
    
    // Check global rate limit (100 req/min)
    const minuteKey = `gc:global:${Math.floor(now.getTime() / 60000)}`;
    const minuteCount = await redis.get(minuteKey);
    
    if (minuteCount && parseInt(minuteCount) >= this.MAX_REQUESTS_PER_MINUTE) {
      return {
        allowed: false,
        nextAvailableTime: new Date(now.getTime() + 60000),
        reason: 'Global rate limit reached (100 req/min)',
      };
    }
    
    return { allowed: true };
  }

  private async loadPendingTasks() {
    const redis = await getRedis();
    
    // Load tasks from Redis sorted set
    const tasks = await redis.zrange('scheduler:queue', 0, -1);
    
    this.queue = tasks.map(t => JSON.parse(t) as ScheduledTask)
      .map(t => ({
        ...t,
        nextRunTime: new Date(t.nextRunTime),
      }))
      .sort((a, b) => a.nextRunTime.getTime() - b.nextRunTime.getTime());
    
    logger.info({ count: this.queue.length }, 'Loaded pending tasks');
  }

  private async processTasks() {
    if (!this.isRunning) return;
    
    const redis = await getRedis();
    const now = new Date();
    const gcClient = getGCClient();
    
    // Get tasks that are ready to run
    const readyTasks = this.queue.filter(t => t.nextRunTime <= now);
    
    if (readyTasks.length === 0) {
      logger.debug('No tasks ready to process');
      return;
    }
    
    logger.info({ count: readyTasks.length }, 'Processing scheduled tasks');
    
    for (const task of readyTasks) {
      // Check if we can run this task
      const canRun = await this.canRunTask(task);
      
      if (!canRun.allowed) {
        // Reschedule for later
        task.nextRunTime = canRun.nextAvailableTime || new Date(now.getTime() + 3600000);
        logger.info({ 
          task: task.id, 
          reason: canRun.reason,
          nextRun: task.nextRunTime 
        }, 'Task postponed due to rate limits');
        
        // Update in Redis
        await redis.zadd(
          'scheduler:queue',
          task.nextRunTime.getTime(),
          JSON.stringify(task)
        );
        
        continue;
      }
      
      // Execute the task
      try {
        logger.info({ task: task.id, type: task.type }, 'Executing scheduled task');
        
        // Update rate limit counters
        const today = now.toISOString().split('T')[0];
        const dailyKey = `gc:daily:${task.accountId}:${today}`;
        const minuteKey = `gc:global:${Math.floor(now.getTime() / 60000)}`;
        
        await redis.incr(dailyKey);
        await redis.expire(dailyKey, 86400);
        await redis.incr(minuteKey);
        await redis.expire(minuteKey, 60);
        
        // Execute based on task type
        switch (task.type) {
          case 'balance':
            const balanceData = await gcClient.getBalance(task.accountId);
            if (balanceData) {
              await redis.setex(
                `balance:${task.accountId}`,
                3600,
                JSON.stringify({
                  balance: balanceData,
                  timestamp: Date.now(),
                })
              );
            }
            logger.info({ accountId: task.accountId }, 'Balance synced successfully');
            this.emit('balanceSynced', { accountId: task.accountId, balance: balanceData });
            break;
            
          case 'transactions':
            const transactions = await gcClient.listTransactions(task.accountId);
            await redis.setex(
              `transactions:${task.accountId}`,
              3600,
              JSON.stringify({
                transactions: transactions,
                timestamp: Date.now(),
              })
            );
            logger.info({ accountId: task.accountId }, 'Transactions synced successfully');
            this.emit('transactionsSynced', { accountId: task.accountId, transactions });
            break;
            
          case 'details':
            const details = await gcClient.getAccountDetails(task.accountId);
            await redis.setex(
              `details:${task.accountId}`,
              86400, // Cache for 24 hours
              JSON.stringify({
                details,
                timestamp: Date.now(),
              })
            );
            logger.info({ accountId: task.accountId }, 'Account details synced successfully');
            this.emit('detailsSynced', { accountId: task.accountId, details });
            break;
        }
        
        // Remove from queue
        await redis.zrem('scheduler:queue', JSON.stringify(task));
        this.queue = this.queue.filter(t => t.id !== task.id);
        
        // Add delay between requests
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (error: any) {
        logger.error({ error, task: task.id }, 'Failed to execute scheduled task');
        
        // Handle rate limit errors
        if (error.response?.status === 429) {
          const retryAfter = parseInt(
            error.response.headers['retry-after'] || 
            error.response.headers['x-ratelimit-account-success-reset'] || 
            '3600'
          );
          
          const retryTime = now.getTime() + (retryAfter * 1000);
          
          // Store rate limit
          await redis.setex(
            `gc:ratelimit:${task.accountId}`,
            retryAfter,
            retryTime.toString()
          );
          
          // Reschedule task
          task.nextRunTime = new Date(retryTime);
          task.lastError = error.response?.data?.detail || 'Rate limit exceeded';
          
          await redis.zadd(
            'scheduler:queue',
            task.nextRunTime.getTime(),
            JSON.stringify(task)
          );
          
          logger.warn({ 
            task: task.id, 
            retryAfter,
            nextRun: task.nextRunTime 
          }, 'Task hit rate limit, rescheduled');
          
          this.emit('rateLimitHit', { 
            accountId: task.accountId, 
            retryAfter,
            message: task.lastError 
          });
          
        } else {
          // Retry with exponential backoff
          task.retryCount++;
          
          if (task.retryCount < 3) {
            task.nextRunTime = new Date(now.getTime() + Math.pow(2, task.retryCount) * 60000);
            task.lastError = error.message;
            
            await redis.zadd(
              'scheduler:queue',
              task.nextRunTime.getTime(),
              JSON.stringify(task)
            );
            
            logger.info({ 
              task: task.id, 
              retryCount: task.retryCount,
              nextRun: task.nextRunTime 
            }, 'Task failed, retrying later');
          } else {
            // Max retries reached, remove task
            await redis.zrem('scheduler:queue', JSON.stringify(task));
            this.queue = this.queue.filter(t => t.id !== task.id);
            
            logger.error({ task: task.id }, 'Task failed after max retries');
            this.emit('taskFailed', { task, error: error.message });
          }
        }
      }
    }
  }

  async getQueueStatus() {
    const redis = await getRedis();
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    
    // Get all accounts
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
    
    // Get rate limit status for each account
    const accountStatus = await Promise.all(
      uniqueAccounts.map(async (accountId) => {
        const rateLimitKey = `gc:ratelimit:${accountId}`;
        const dailyKey = `gc:daily:${accountId}:${today}`;
        
        const rateLimitExpiry = await redis.get(rateLimitKey);
        const dailyCount = await redis.get(dailyKey);
        
        const pendingTasks = this.queue.filter(t => t.accountId === accountId);
        
        return {
          accountId,
          dailyUsed: parseInt(dailyCount || '0'),
          dailyRemaining: this.DAILY_LIMIT - parseInt(dailyCount || '0'),
          isRateLimited: !!rateLimitExpiry && parseInt(rateLimitExpiry) > now.getTime(),
          rateLimitExpiry: rateLimitExpiry ? new Date(parseInt(rateLimitExpiry)) : null,
          pendingTasks: pendingTasks.length,
          nextTask: pendingTasks[0]?.nextRunTime || null,
        };
      })
    );
    
    return {
      isRunning: this.isRunning,
      queueLength: this.queue.length,
      accounts: accountStatus,
      nextProcessing: this.queue[0]?.nextRunTime || null,
    };
  }
}

// Singleton instance
let scheduler: SmartScheduler | null = null;

export function getScheduler(): SmartScheduler {
  if (!scheduler) {
    scheduler = new SmartScheduler();
  }
  return scheduler;
}