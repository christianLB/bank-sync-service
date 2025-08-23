import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import { config } from '../config';
import { logger } from '../logger';
import { getGCAuth } from './gcAuth';
import { getRequisitionManager } from './requisition';

export interface GCAccount {
  id: string;
  iban: string;
  institution_id: string;
  created?: string;
  last_accessed?: string;
  status: 'DISCOVERED' | 'PROCESSING' | 'READY' | 'ERROR' | 'SUSPENDED';
  owner_name?: string;
}

export interface GCBalance {
  balanceAmount: {
    amount: string;
    currency: string;
  };
  balanceType: string;
  referenceDate: string;
}

export interface GCTransaction {
  transactionId: string;
  bookingDate: string;
  valueDate?: string;
  transactionAmount: {
    amount: string;
    currency: string;
  };
  remittanceInformationUnstructured?: string;
  remittanceInformationStructured?: string;
  creditorName?: string;
  creditorAccount?: {
    iban?: string;
  };
  debtorName?: string;
  debtorAccount?: {
    iban?: string;
  };
  bankTransactionCode?: string;
  proprietaryBankTransactionCode?: string;
  internalTransactionId?: string;
}

export interface TransactionPage {
  transactions: GCTransaction[];
  next?: string;
  total?: number;
}

export interface WebhookEvent {
  id: string;
  created_at: string;
  resource_type: string;
  action: string;
  links: Record<string, any>;
  details?: Record<string, any>;
}

export class GoCardlessClient {
  private client: AxiosInstance;
  private auth: ReturnType<typeof getGCAuth>;
  private requisitionManager: ReturnType<typeof getRequisitionManager>;
  private webhookSecret?: string;

  constructor() {
    this.auth = getGCAuth();
    this.requisitionManager = getRequisitionManager();
    this.client = axios.create({
      baseURL: config.gocardless.baseUrl,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      timeout: 30000,
    });

    this.webhookSecret = config.gocardless.webhookSecret;

    // Request interceptor for auth and logging
    this.client.interceptors.request.use(
      async (req) => {
        // Add auth token
        const token = await this.auth.getAccessToken();
        req.headers.Authorization = `Bearer ${token}`;
        
        logger.debug({ 
          method: req.method, 
          url: req.url,
          params: req.params 
        }, 'GoCardless API request');
        return req;
      },
      (error) => {
        logger.error({ err: error }, 'GoCardless request error');
        return Promise.reject(error);
      }
    );

    // Response interceptor for error handling
    this.client.interceptors.response.use(
      (response) => response,
      (error) => {
        logger.error({ 
          err: error,
          status: error.response?.status,
          data: error.response?.data
        }, 'GoCardless API error');
        return Promise.reject(error);
      }
    );
  }

  async listAccounts(): Promise<GCAccount[]> {
    try {
      // First, get all linked requisitions
      const requisitions = await this.requisitionManager.listRequisitions();
      const allAccounts: GCAccount[] = [];
      
      // Get accounts from linked requisitions
      for (const req of requisitions.results) {
        if (req.status === 'LN' && req.accounts) {
          for (const accountId of req.accounts) {
            const account = await this.getAccount(accountId);
            if (account) {
              allAccounts.push(account);
              // Map account to requisition
              await this.requisitionManager.mapAccountToRequisition(accountId, req.id);
            }
          }
        }
      }
      
      return allAccounts;
    } catch (err) {
      logger.error({ err }, 'Failed to list accounts');
      throw err;
    }
  }

  async getAccount(accountId: string): Promise<GCAccount | null> {
    try {
      const response = await this.client.get(`/api/v2/accounts/${accountId}/`);
      return response.data;
    } catch (err: any) {
      if (err.response?.status === 404) {
        return null;
      }
      logger.error({ err, accountId }, 'Failed to get account');
      throw err;
    }
  }

  async getBalance(accountId: string): Promise<GCBalance | null> {
    try {
      const response = await this.client.get(`/api/v2/accounts/${accountId}/balances/`);
      const balances = response.data.balances || [];
      return balances[0] || null;
    } catch (err: any) {
      logger.error({ err, accountId }, 'Failed to get balance');
      // Re-throw rate limit errors so they can be handled properly
      if (err.response?.status === 429) {
        throw err;
      }
      return null;
    }
  }

  async getAccountDetails(accountId: string): Promise<any> {
    try {
      const response = await this.client.get(`/api/v2/accounts/${accountId}/details/`);
      return response.data.account;
    } catch (err) {
      logger.error({ err, accountId }, 'Failed to get account details');
      return null;
    }
  }

  async listTransactions(
    accountId: string,
    options: {
      date_from?: string;
      date_to?: string;
    } = {}
  ): Promise<TransactionPage> {
    try {
      const params: any = {};
      if (options.date_from) params.date_from = options.date_from;
      if (options.date_to) params.date_to = options.date_to;

      const response = await this.client.get(
        `/api/v2/accounts/${accountId}/transactions/`,
        { params }
      );

      // GoCardless returns transactions in booked and pending arrays
      const transactions = [
        ...(response.data.transactions?.booked || []),
        ...(response.data.transactions?.pending || [])
      ];

      return {
        transactions,
        next: undefined, // GoCardless doesn't use cursor pagination for transactions
        total: transactions.length,
      };
    } catch (err) {
      logger.error({ err, accountId, options }, 'Failed to list transactions');
      throw err;
    }
  }

  async *listTransactionPages(
    accountId: string,
    options: {
      date_from?: string;
      date_to?: string;
    } = {}
  ): AsyncGenerator<TransactionPage> {
    // GoCardless doesn't use cursor pagination for transactions
    // It returns all transactions within the date range in one call
    const page = await this.listTransactions(accountId, {
      date_from: options.date_from,
      date_to: options.date_to,
    });

    yield page;
  }

  verifyWebhookSignature(
    body: string,
    signature: string
  ): boolean {
    if (!this.webhookSecret) {
      logger.warn('No webhook secret configured');
      return false;
    }
    
    try {
      const expectedSignature = crypto
        .createHmac('sha256', this.webhookSecret)
        .update(body)
        .digest('hex');

      return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature)
      );
    } catch (err) {
      logger.error({ err }, 'Failed to verify webhook signature');
      return false;
    }
  }

  normalizeTransaction(tx: GCTransaction): {
    externalRef: string;
    amount: number;
    direction: 'in' | 'out';
    description: string;
    counterparty: {
      name?: string;
      iban?: string;
    };
  } {
    const amount = Math.abs(parseFloat(tx.transactionAmount.amount));
    const direction = parseFloat(tx.transactionAmount.amount) >= 0 ? 'in' : 'out';
    
    // Build external reference
    const externalRef = tx.internalTransactionId || tx.transactionId;
    
    // Extract description
    const description = tx.remittanceInformationUnstructured || 
                       tx.remittanceInformationStructured || 
                       '';

    // Determine counterparty
    const counterparty: any = {};
    if (direction === 'in') {
      counterparty.name = tx.debtorName;
      counterparty.iban = tx.debtorAccount?.iban;
    } else {
      counterparty.name = tx.creditorName;
      counterparty.iban = tx.creditorAccount?.iban;
    }

    return {
      externalRef,
      amount,
      direction,
      description,
      counterparty,
    };
  }
}

// Singleton instance
let gcClient: GoCardlessClient | null = null;

export function getGCClient(): GoCardlessClient {
  if (!gcClient) {
    gcClient = new GoCardlessClient();
  }
  return gcClient;
}