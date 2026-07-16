export interface Capabilities {
  name: string;
  namespaces: string[];
  max_access_level: 'normal' | 'sensitive' | 'secret';
  capabilities: { read: boolean; write: boolean; delete: boolean; admin: boolean };
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
  session_id: string | null;
  created_at: string;
  updated_at: string;
  accessed_at: string;
  access_count: number;
  relevance_score: number;
  superseded_at: string | null;
  expires_at: string | null;
}

export interface PagedMemories {
  memories: MemoryRecord[];
  total: number;
  limit: number;
  offset: number;
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
