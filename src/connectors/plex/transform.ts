import type { MediaEventInput } from '../../media.js';

export interface PlexHistoryItem {
  ratingKey: string;
  key?: string;
  type: 'movie' | 'episode' | 'track' | string;
  title: string;
  grandparentTitle?: string;       // show title for episodes / artist for tracks
  parentTitle?: string;            // season label for episodes / album for tracks
  grandparentKey?: string;
  parentKey?: string;
  index?: number;                   // episode # for episodes / track # for tracks
  parentIndex?: number;             // season # for episodes
  year?: number;
  duration?: number;                // ms
  viewedAt: number;                 // epoch seconds
  accountID: number;
  deviceID?: number;
  librarySectionID?: number | string;
  librarySectionTitle?: string;
  thumb?: string;
  grandparentThumb?: string;
}

export function toMediaEvent(item: PlexHistoryItem, server: { name: string; clientIdentifier: string }): MediaEventInput | null {
  if (!item.ratingKey || !item.viewedAt || !item.title) return null;

  const playedAt = new Date(item.viewedAt * 1000).toISOString();
  const base = {
    service: 'plex',
    service_id: `${server.clientIdentifier}:${item.ratingKey}`,
    event_type: 'watch',
    title: item.title,
    year: item.year,
    duration_ms: item.duration,
    played_ms: item.duration,
    completed: true,
    played_at: playedAt,
  };

  const metadata: Record<string, unknown> = {
    rating_key: item.ratingKey,
    plex_type: item.type,
    server_name: server.name,
    server_id: server.clientIdentifier,
    library_section: item.librarySectionTitle,
    thumb: item.thumb,
    grandparent_thumb: item.grandparentThumb,
  };

  if (item.type === 'episode') {
    return {
      ...base,
      show: item.grandparentTitle,
      season: item.parentIndex,
      episode: item.index,
      metadata,
    };
  }

  if (item.type === 'track') {
    return {
      ...base,
      event_type: 'play',
      artist: item.grandparentTitle,
      album: item.parentTitle,
      metadata,
    };
  }

  // movie / other
  return { ...base, metadata };
}
