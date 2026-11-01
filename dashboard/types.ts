export interface Capabilities {
  name: string;
  namespaces: string[];
  max_access_level: 'normal' | 'sensitive' | 'secret';
  capabilities: { read: boolean; write: boolean; delete: boolean; admin: boolean; export: boolean; import: boolean };
}

export type MemoryIngestionState = 'queued' | 'ready' | 'deduplicated' | 'embedding_failed' | 'cancelled';

/**
 * Content-free durable-ingestion status. Present only while the server runs
 * the ingestion queue; owners see every field, other readers see state only.
 */
export interface MemoryIngestion {
  state: MemoryIngestionState;
  accepted_at?: string;
  ready_at?: string | null;
  attempts?: number;
  next_retry_at?: string | null;
  failure_category?: string | null;
  canonical_memory_id?: string | null;
  similarity?: number | null;
}

export type IngestionJobStatus = 'pending' | 'processing' | 'retry_wait' | 'ready' | 'deduplicated' | 'embedding_failed' | 'cancelled';
export type IngestionFailureCategory = 'transient' | 'rate_limited' | 'provider_auth' | 'input_rejected' | 'space_mismatch' | 'expired';

/** GET /api/ingestion/stats: content-free queue aggregates for admins. */
export interface IngestionStats {
  enabled: boolean;
  depth: Record<IngestionJobStatus, number>;
  queued: number;
  oldest_pending_age_seconds: number | null;
  next_retry_at: string | null;
  attempts_histogram: Array<{ attempts: number; count: number }>;
  failure_categories: Record<IngestionFailureCategory, number>;
  inline: { attempted: number; ready: number; deduplicated: number; queued: number };
  worker: { paused: boolean; last_seen_at: string | null };
}

export interface IngestionRequeueResult {
  memory_id: string;
  namespace: string;
  status: 'pending';
  previous_status: 'embedding_failed' | 'cancelled';
  previous_attempts: number;
  requeued_at: string;
}

export interface IngestionPauseState {
  paused: boolean;
}

export interface MemoryRecord {
  id: string;
  content: string;
  source: string;
  namespace: string;
  tags: string[];
  metadata: Record<string, unknown>;
  access_level: string;
  client_id: string;
  agent_id: string | null;
  provenance?: {
    agent_id: string;
    agent_name: string;
    agent_type: string | null;
    agent_model: string | null;
    agent_runtime: string | null;
    same_key_as_requester: boolean;
  } | null;
  session_id: string | null;
  created_at: string;
  updated_at: string;
  accessed_at: string;
  access_count: number;
  relevance_score: number;
  superseded_at: string | null;
  expires_at: string | null;
  ingestion?: MemoryIngestion | null;
}

export interface PagedMemories {
  memories: MemoryRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface AgentRecord {
  id: string;
  name: string;
  type: string | null;
  model: string | null;
  runtime: string | null;
  memory_count: number;
  last_memory_at: string | null;
  last_seen_at: string | null;
}

export interface TraceRecord {
  id: string;
  session_id: string | null;
  agent_id: string | null;
  agent_name?: string | null;
  query_text: string;
  memory_ids: string[];
  result_count: number;
  scores: unknown[];
  duration_ms: number | null;
  created_at: string;
}

export interface MediaStats {
  total_events: number;
  listening_duration_ms: number;
  plays_by_service: Array<{ service: string; count: number; duration_ms: number }>;
  top_artists: Array<{ artist: string; plays: number; duration_ms: number }>;
  top_albums: Array<{ album: string; artist: string | null; plays: number; duration_ms: number }>;
  top_tracks: Array<{ title: string; artist: string | null; plays: number; duration_ms: number }>;
  daily: Array<{ date: string; count: number; duration_ms: number }>;
}
