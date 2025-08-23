import axios, { AxiosInstance } from 'axios';
import { v4 as uuid } from 'uuid';
import { getRedis } from './redis';
import { getGCAuth } from './gcAuth';
import { logger } from '../logger';
import { config } from '../config';

const REQUISITION_PREFIX = 'gc:requisition:';
const AGREEMENT_PREFIX = 'gc:agreement:';
const INSTITUTION_CACHE_PREFIX = 'gc:institutions:';
const REQUISITION_TTL = 90 * 24 * 60 * 60; // 90 days
const INSTITUTION_CACHE_TTL = 24 * 60 * 60; // 1 day

export interface Institution {
  id: string;
  name: string;
  bic: string;
  transaction_total_days: string;
  countries: string[];
  logo: string;
}

export interface Agreement {
  id: string;
  created: string;
  max_historical_days: number;
  access_valid_for_days: number;
  access_scope: string[];
  accepted?: string;
  institution_id: string;
}

export interface Requisition {
  id: string;
  created: string;
  redirect: string;
  status: 'CR' | 'LN' | 'RJ' | 'ER' | 'EX' | 'GA' | 'UA' | 'SU';
  institution_id: string;
  agreement: string;
  reference: string;
  accounts: string[];
  user_language: string;
  link: string;
}

export interface RequisitionStatus {
  CR: 'CREATED';     // Requisition created
  LN: 'LINKED';      // Account linked
  RJ: 'REJECTED';    // User rejected
  ER: 'ERROR';       // Error occurred
  EX: 'EXPIRED';     // Access expired
  GA: 'GIVING_CONSENT'; // User giving consent
  UA: 'UNDERGOING_AUTHENTICATION'; // User authenticating
  SU: 'SUSPENDED';   // Access suspended
}

export class RequisitionManager {
  private client: AxiosInstance;
  private auth: ReturnType<typeof getGCAuth>;

  constructor() {
    this.auth = getGCAuth();
    this.client = axios.create({
      baseURL: config.gocardless.baseUrl,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      timeout: 30000,
    });

    // Add auth interceptor
    this.client.interceptors.request.use(async (config) => {
      const token = await this.auth.getAccessToken();
      config.headers.Authorization = `Bearer ${token}`;
      return config;
    });
  }

  /**
   * List available institutions for a country
   */
  async listInstitutions(countryCode: string): Promise<Institution[]> {
    const redis = getRedis();
    const cacheKey = `${INSTITUTION_CACHE_PREFIX}${countryCode}`;
    
    try {
      // Check cache first
      const cached = await redis.get(cacheKey);
      if (cached) {
        logger.debug({ countryCode }, 'Using cached institutions');
        return JSON.parse(cached);
      }
      
      // Fetch from API
      const response = await this.client.get(
        `/api/v2/institutions/?country=${countryCode}`
      );
      
      const institutions = response.data as Institution[];
      
      // Cache the result
      await redis.set(
        cacheKey,
        JSON.stringify(institutions),
        'EX',
        INSTITUTION_CACHE_TTL
      );
      
      logger.info({ 
        countryCode, 
        count: institutions.length 
      }, 'Fetched institutions');
      
      return institutions;
    } catch (err: any) {
      logger.error({ err, countryCode }, 'Failed to list institutions');
      throw new Error(`Failed to list institutions: ${err.message}`);
    }
  }

  /**
   * Get a specific institution by ID
   */
  async getInstitution(institutionId: string): Promise<Institution | null> {
    try {
      const response = await this.client.get(
        `/api/v2/institutions/${institutionId}/`
      );
      
      return response.data as Institution;
    } catch (err: any) {
      if (err.response?.status === 404) {
        return null;
      }
      logger.error({ err, institutionId }, 'Failed to get institution');
      throw err;
    }
  }

  /**
   * Create an end-user agreement
   */
  async createAgreement(
    institutionId: string,
    maxHistoricalDays: number = 90,
    accessValidForDays: number = 90,
    accessScope: string[] = ['balances', 'details', 'transactions']
  ): Promise<Agreement> {
    try {
      const response = await this.client.post(
        '/api/v2/agreements/enduser/',
        {
          institution_id: institutionId,
          max_historical_days: maxHistoricalDays,
          access_valid_for_days: accessValidForDays,
          access_scope: accessScope,
        }
      );
      
      const agreement = response.data as Agreement;
      
      // Store in Redis
      const redis = getRedis();
      await redis.set(
        `${AGREEMENT_PREFIX}${agreement.id}`,
        JSON.stringify(agreement),
        'EX',
        accessValidForDays * 24 * 60 * 60
      );
      
      logger.info({ 
        agreementId: agreement.id,
        institutionId 
      }, 'Created agreement');
      
      return agreement;
    } catch (err: any) {
      logger.error({ err, institutionId }, 'Failed to create agreement');
      throw new Error(`Failed to create agreement: ${err.message}`);
    }
  }

  /**
   * Create a requisition for bank account linking
   */
  async createRequisition(
    institutionId: string,
    redirectUrl: string,
    agreementId?: string,
    reference?: string,
    userLanguage: string = 'EN'
  ): Promise<Requisition> {
    try {
      // Create agreement if not provided
      let agreement = agreementId;
      if (!agreement) {
        const newAgreement = await this.createAgreement(institutionId);
        agreement = newAgreement.id;
      }
      
      const requisitionData = {
        redirect: redirectUrl,
        institution_id: institutionId,
        reference: reference || uuid(),
        agreement,
        user_language: userLanguage,
      };
      
      const response = await this.client.post(
        '/api/v2/requisitions/',
        requisitionData
      );
      
      const requisition = response.data as Requisition;
      
      // Store in Redis
      const redis = getRedis();
      await redis.set(
        `${REQUISITION_PREFIX}${requisition.id}`,
        JSON.stringify(requisition),
        'EX',
        REQUISITION_TTL
      );
      
      logger.info({ 
        requisitionId: requisition.id,
        institutionId,
        status: requisition.status,
        link: requisition.link
      }, 'Created requisition');
      
      return requisition;
    } catch (err: any) {
      logger.error({ err, institutionId }, 'Failed to create requisition');
      throw new Error(`Failed to create requisition: ${err.message}`);
    }
  }

  /**
   * Get requisition by ID
   */
  async getRequisition(requisitionId: string): Promise<Requisition | null> {
    const redis = getRedis();
    
    try {
      // Check cache first
      const cached = await redis.get(`${REQUISITION_PREFIX}${requisitionId}`);
      if (cached) {
        const requisition = JSON.parse(cached) as Requisition;
        
        // If status is final, return from cache
        if (['LN', 'RJ', 'ER', 'EX', 'SU'].includes(requisition.status)) {
          return requisition;
        }
      }
      
      // Fetch from API
      const response = await this.client.get(
        `/api/v2/requisitions/${requisitionId}/`
      );
      
      const requisition = response.data as Requisition;
      
      // Update cache
      await redis.set(
        `${REQUISITION_PREFIX}${requisitionId}`,
        JSON.stringify(requisition),
        'EX',
        REQUISITION_TTL
      );
      
      return requisition;
    } catch (err: any) {
      if (err.response?.status === 404) {
        return null;
      }
      logger.error({ err, requisitionId }, 'Failed to get requisition');
      throw err;
    }
  }

  /**
   * Delete a requisition
   */
  async deleteRequisition(requisitionId: string): Promise<void> {
    try {
      await this.client.delete(`/api/v2/requisitions/${requisitionId}/`);
      
      // Remove from cache
      const redis = getRedis();
      await redis.del(`${REQUISITION_PREFIX}${requisitionId}`);
      
      logger.info({ requisitionId }, 'Deleted requisition');
    } catch (err: any) {
      logger.error({ err, requisitionId }, 'Failed to delete requisition');
      throw err;
    }
  }

  /**
   * Get accounts linked to a requisition
   */
  async getRequisitionAccounts(requisitionId: string): Promise<string[]> {
    const requisition = await this.getRequisition(requisitionId);
    
    if (!requisition) {
      throw new Error(`Requisition ${requisitionId} not found`);
    }
    
    if (requisition.status !== 'LN') {
      logger.warn({ 
        requisitionId, 
        status: requisition.status 
      }, 'Requisition not in LINKED status');
      return [];
    }
    
    return requisition.accounts || [];
  }

  /**
   * Check if requisition is ready (accounts linked)
   */
  async isRequisitionReady(requisitionId: string): Promise<boolean> {
    const requisition = await this.getRequisition(requisitionId);
    
    if (!requisition) {
      return false;
    }
    
    return requisition.status === 'LN' && requisition.accounts.length > 0;
  }

  /**
   * Get requisition status description
   */
  getStatusDescription(status: keyof RequisitionStatus): string {
    const descriptions: RequisitionStatus = {
      CR: 'CREATED',
      LN: 'LINKED',
      RJ: 'REJECTED',
      ER: 'ERROR',
      EX: 'EXPIRED',
      GA: 'GIVING_CONSENT',
      UA: 'UNDERGOING_AUTHENTICATION',
      SU: 'SUSPENDED',
    };
    
    return descriptions[status] || 'UNKNOWN';
  }

  /**
   * List all requisitions
   */
  async listRequisitions(limit: number = 100, offset: number = 0): Promise<{
    count: number;
    next: string | null;
    previous: string | null;
    results: Requisition[];
  }> {
    try {
      const response = await this.client.get('/api/v2/requisitions/', {
        params: { limit, offset },
      });
      
      return response.data;
    } catch (err: any) {
      logger.error({ err }, 'Failed to list requisitions');
      throw err;
    }
  }

  /**
   * Store account-requisition mapping
   */
  async mapAccountToRequisition(
    accountId: string,
    requisitionId: string
  ): Promise<void> {
    const redis = getRedis();
    const key = `gc:account:requisition:${accountId}`;
    
    await redis.set(key, requisitionId, 'EX', REQUISITION_TTL);
    
    logger.debug({ accountId, requisitionId }, 'Mapped account to requisition');
  }

  /**
   * Get requisition ID for an account
   */
  async getAccountRequisition(accountId: string): Promise<string | null> {
    const redis = getRedis();
    const key = `gc:account:requisition:${accountId}`;
    
    return await redis.get(key);
  }
}

// Singleton instance
let requisitionManager: RequisitionManager | null = null;

export function getRequisitionManager(): RequisitionManager {
  if (!requisitionManager) {
    requisitionManager = new RequisitionManager();
  }
  return requisitionManager;
}