export interface BankTransaction {
  txId: string;
  externalRef: string;
  accountId: string;
  source: 'bank';
  provider: string;
  asset: string;
  amount: number;
  fee: number;
  direction: 'in' | 'out';
  bookedAt: string;
  valueDate?: string;
  description?: string;
  reference?: string;
  counterparty?: {
    name?: string;
    iban?: string;
    bic?: string;
  };
  metadata?: Record<string, any>;
}

export interface SyncOperation {
  operationId: string;
  accountId: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  processed: number;
  errors: string[];
  cursor?: string;
}

export interface AccountInfo {
  id: string;
  name: string;
  provider: string;
  iban: string;
  currency: string;
  balance?: number;
  lastSyncAt?: string;
  status: 'active' | 'inactive' | 'suspended';
}