export type AccessLevel = 'normal' | 'sensitive' | 'secret';
export type MemoryKind = 'unspecified' | 'semantic' | 'document_chunk' | 'episode_chunk' | 'synced' | 'media_rollup' | 'consolidation' | 'insight';

export interface Memory {
  id: string;
  content: string;
  embedding?: number[];
  embedding_provider?: string | null;
  embedding_model?: string | null;
  embedding_dimensions?: number | null;
  source: string;
  namespace: string;
  tags: string[];
  metadata: Record<string, unknown>;
  access_level: AccessLevel;
  client_id: string;
  created_at: Date;
  event_at?: Date | null;
  updated_at: Date;
  accessed_at: Date;
  access_count: number;
  deleted_at?: Date | null;
  memory_kind?: MemoryKind;
  valid_from?: Date | null;
  valid_to?: Date | null;
  supersedes_id?: string | null;
  superseded_at?: Date | null;
  superseded_by_id?: string | null;
  is_superseded?: boolean;
  revision?: number;
  entity_source_revision?: number;
  consolidated_into_id?: string | null;
  consolidated_at?: Date | null;
  origin_namespace?: string | null;
  insight_content_hash?: string | null;
  expires_at?: Date | null;
}

export interface ApiKey {
  id: string;
  key_hash: string;
  name: string;
  namespaces: string[];
  permissions: string[];
  max_access_level: AccessLevel;
  created_at: Date;
  last_used_at: Date | null;
  enabled: boolean;
}

export interface SearchResult extends Memory {
  vec_score: number | null;
  text_score: number;
  final_score: number;
}

export interface StoreParams {
  content: string;
  namespace?: string;
  source?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  access_level?: AccessLevel;
  agent_name?: string;
  agent_type?: string;
  agent_model?: string;
  agent_runtime?: string;
  session_id?: string;
  idempotency_key?: string;
  dedupe?: boolean;
  /** Positive integer lifetime in seconds. */
  ttl?: number;
}

export interface StoreResult {
  id: string;
  namespace: string;
  created: boolean;
  deduplicated: boolean;
  similarity?: number;
  idempotency_key_honored?: true;
  expires_at: Date | null;
}

export interface UpdateParams {
  id: string;
  content?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  supersedes?: string;
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
  valid_at?: string;
  mediaFilters?: MediaSearchFilters;
}

export interface MediaSearchFilters {
  services?: string[];
  eventTypes?: string[];
  eventAfter?: string;
  eventBefore?: string;
  eventBeforeExclusive?: boolean;
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
  confirm?: boolean;
  reason?: string;
}

export interface ForgetResult {
  forgotten: string[];
  count: number;
}

export interface StatsParams {
  namespace?: string;
}

export interface MemorySubscription {
  id: string;
  api_key_id: string;
  query: string;
  namespaces: string[];
  threshold: number;
  exclude_self: boolean;
  status: 'active' | 'disabled';
  created_at: Date;
  disabled_at: Date | null;
}

export type WebhookDeliveryStatus = 'pending' | 'processing' | 'retry' | 'delivered' | 'dead' | 'cancelled';

export interface AuthContext {
  keyId: string;
  name: string;
  namespaces: string[];
  permissions: string[];
  maxAccessLevel: AccessLevel;
}

export interface Agent {
  id: string;
  name: string;
  type: string;
  model: string | null;
  runtime: string | null;
  parent_agent_id: string | null;
  api_key_id: string | null;
  metadata: Record<string, unknown>;
  first_seen_at: Date;
  last_seen_at: Date;
}

export interface AgentParams {
  name: string;
  type?: string;
  model?: string;
  runtime?: string;
  parent_agent_name?: string;
  api_key_id: string;
  metadata?: Record<string, unknown>;
}

export interface SystemAgentParams {
  name: string;
  type?: string;
  model?: string;
  runtime?: string;
  metadata?: Record<string, unknown>;
}

export interface RecallTrace {
  id: string;
  session_id: string | null;
  agent_id: string | null;
  client_id: string | null;
  query_text: string;
  memory_ids: string[];
  result_count: number;
  scores: unknown[];
  duration_ms: number | null;
  created_at: Date;
}
