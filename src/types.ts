export interface Memory {
  id: string;
  content: string;
  embedding?: number[];
  source: string;
  namespace: string;
  tags: string[];
  metadata: Record<string, unknown>;
  access_level: 'normal' | 'sensitive' | 'secret';
  client_id: string;
  created_at: Date;
  updated_at: Date;
  accessed_at: Date;
  access_count: number;
}

export interface ApiKey {
  id: string;
  key_hash: string;
  name: string;
  namespaces: string[];
  permissions: string[];
  created_at: Date;
  last_used_at: Date | null;
  enabled: boolean;
}

export interface SearchResult extends Memory {
  vec_score: number;
  text_score: number;
  final_score: number;
}

export interface StoreParams {
  content: string;
  namespace?: string;
  source?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  access_level?: 'normal' | 'sensitive' | 'secret';
}

export interface SearchParams {
  query: string;
  namespaces?: string[];
  limit?: number;
  threshold?: number;
  tags?: string[];
  source?: string;
  after?: string;
  before?: string;
}

export interface ListParams {
  namespace?: string;
  source?: string;
  tags?: string[];
  limit?: number;
  offset?: number;
}

export interface ForgetParams {
  ids?: string[];
  namespace?: string;
  before?: string;
  tags?: string[];
}

export interface StatsParams {
  namespace?: string;
}

export interface AuthContext {
  keyId: string;
  name: string;
  namespaces: string[];
  permissions: string[];
}
