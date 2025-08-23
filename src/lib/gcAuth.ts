import axios from 'axios';
import { getRedis } from './redis';
import { logger } from '../logger';
import { config } from '../config';

const TOKEN_KEY = 'gc:auth:token';
const TOKEN_REFRESH_KEY = 'gc:auth:refresh';
const TOKEN_EXPIRY_KEY = 'gc:auth:expiry';
const TOKEN_BUFFER_SECONDS = 300; // Refresh 5 minutes before expiry

export interface TokenResponse {
  access: string;
  access_expires: number;
  refresh: string;
  refresh_expires: number;
}

export interface StoredToken {
  access: string;
  refresh: string;
  accessExpiry: number;
  refreshExpiry: number;
  createdAt: string;
}

export class GoCardlessAuth {
  private baseUrl: string;

  constructor() {
    this.baseUrl = config.gocardless.baseUrl;
  }

  /**
   * Generate a new access token using secret_id and secret_key
   */
  async generateToken(): Promise<TokenResponse> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/api/v2/token/new/`,
        {
          secret_id: config.gocardless.secretId,
          secret_key: config.gocardless.secretKey,
        },
        {
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
        }
      );

      const tokenData = response.data as TokenResponse;
      
      // Store token in Redis
      await this.storeToken(tokenData);
      
      logger.info('Generated new GoCardless access token');
      return tokenData;
    } catch (err: any) {
      logger.error({ 
        err, 
        status: err.response?.status,
        data: err.response?.data 
      }, 'Failed to generate GoCardless token');
      throw new Error(`Failed to generate token: ${err.message}`);
    }
  }

  /**
   * Refresh an existing token
   */
  async refreshToken(refreshToken: string): Promise<TokenResponse> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/api/v2/token/refresh/`,
        {
          refresh: refreshToken,
        },
        {
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
        }
      );

      const tokenData = response.data as TokenResponse;
      
      // Store refreshed token
      await this.storeToken(tokenData);
      
      logger.info('Refreshed GoCardless access token');
      return tokenData;
    } catch (err: any) {
      logger.error({ err }, 'Failed to refresh GoCardless token');
      
      // If refresh fails, generate a new token
      logger.info('Refresh failed, generating new token');
      return this.generateToken();
    }
  }

  /**
   * Get a valid access token (generate or refresh as needed)
   */
  async getAccessToken(): Promise<string> {
    const redis = getRedis();
    
    try {
      // Check if we have a stored token
      const storedToken = await redis.get(TOKEN_KEY);
      const storedExpiry = await redis.get(TOKEN_EXPIRY_KEY);
      const storedRefresh = await redis.get(TOKEN_REFRESH_KEY);
      
      if (!storedToken || !storedExpiry) {
        // No token stored, generate new one
        const newToken = await this.generateToken();
        return newToken.access;
      }
      
      const expiryTime = parseInt(storedExpiry);
      const now = Math.floor(Date.now() / 1000);
      
      // Check if token is still valid (with buffer)
      if (now < expiryTime - TOKEN_BUFFER_SECONDS) {
        // Token is still valid
        return storedToken;
      }
      
      // Token is expired or about to expire
      if (storedRefresh) {
        // Try to refresh
        logger.info('Access token expiring, refreshing');
        const refreshed = await this.refreshToken(storedRefresh);
        return refreshed.access;
      } else {
        // No refresh token, generate new
        logger.info('No refresh token available, generating new token');
        const newToken = await this.generateToken();
        return newToken.access;
      }
    } catch (err) {
      logger.error({ err }, 'Error getting access token');
      // Fallback to generating new token
      const newToken = await this.generateToken();
      return newToken.access;
    }
  }

  /**
   * Store token in Redis
   */
  private async storeToken(tokenData: TokenResponse): Promise<void> {
    const redis = getRedis();
    
    try {
      const now = Math.floor(Date.now() / 1000);
      
      // Store access token with TTL
      await redis.set(
        TOKEN_KEY,
        tokenData.access,
        'EX',
        tokenData.access_expires
      );
      
      // Store refresh token with TTL
      if (tokenData.refresh) {
        await redis.set(
          TOKEN_REFRESH_KEY,
          tokenData.refresh,
          'EX',
          tokenData.refresh_expires
        );
      }
      
      // Store expiry time for checking
      await redis.set(
        TOKEN_EXPIRY_KEY,
        (now + tokenData.access_expires).toString(),
        'EX',
        tokenData.access_expires
      );
      
      // Store full token data as backup
      const storedToken: StoredToken = {
        access: tokenData.access,
        refresh: tokenData.refresh,
        accessExpiry: now + tokenData.access_expires,
        refreshExpiry: now + tokenData.refresh_expires,
        createdAt: new Date().toISOString(),
      };
      
      await redis.set(
        'gc:auth:token:full',
        JSON.stringify(storedToken),
        'EX',
        tokenData.access_expires
      );
      
      logger.debug({ 
        accessExpiry: tokenData.access_expires,
        refreshExpiry: tokenData.refresh_expires 
      }, 'Token stored in Redis');
    } catch (err) {
      logger.error({ err }, 'Failed to store token in Redis');
      throw err;
    }
  }

  /**
   * Clear stored tokens (useful for logout or reset)
   */
  async clearTokens(): Promise<void> {
    const redis = getRedis();
    
    try {
      await redis.del(TOKEN_KEY, TOKEN_REFRESH_KEY, TOKEN_EXPIRY_KEY, 'gc:auth:token:full');
      logger.info('Cleared stored GoCardless tokens');
    } catch (err) {
      logger.error({ err }, 'Failed to clear tokens');
    }
  }

  /**
   * Check if we have a valid token
   */
  async hasValidToken(): Promise<boolean> {
    try {
      const token = await this.getAccessToken();
      return !!token;
    } catch {
      return false;
    }
  }
}

// Singleton instance
let authInstance: GoCardlessAuth | null = null;

export function getGCAuth(): GoCardlessAuth {
  if (!authInstance) {
    authInstance = new GoCardlessAuth();
  }
  return authInstance;
}