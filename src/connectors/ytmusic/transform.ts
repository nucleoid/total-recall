import type { MediaEventInput } from '../../media.js';

interface YtArtist {
  name?: string;
  id?: string;
}

interface YtAlbum {
  name?: string;
  id?: string;
}

interface YtThumbnail {
  url?: string;
  width?: number;
  height?: number;
}

export interface YtHistoryItem {
  videoId?: string;
  title?: string;
  artists?: YtArtist[] | null;
  album?: YtAlbum | null;
  duration?: string;             // "3:54"
  duration_seconds?: number;
  thumbnails?: YtThumbnail[];
  played?: string;               // ISO timestamp from ytmusicapi
  played_raw?: string;
  played_precision?: string;
  played_bucket?: string;
  played_bucket_start?: string;
  played_bucket_end?: string;
  played_cursor_eligible?: boolean;
  feedbackToken?: string;
  videoType?: string;
  likeStatus?: string;
}

function parseDurationSeconds(item: YtHistoryItem): number | undefined {
  if (typeof item.duration_seconds === 'number') return item.duration_seconds;
  if (item.duration) {
    const parts = item.duration.split(':').map((p) => parseInt(p, 10));
    if (parts.every((n) => Number.isFinite(n))) {
      return parts.reduce((acc, n) => acc * 60 + n, 0);
    }
  }
  return undefined;
}

function joinArtists(artists?: YtArtist[] | null): string | undefined {
  if (!artists?.length) return undefined;
  const names = artists.map((a) => a.name).filter(Boolean) as string[];
  return names.length ? names.join(', ') : undefined;
}

export function toMediaEvent(item: YtHistoryItem): MediaEventInput | null {
  if (!item.title || !item.played) return null;
  const playedAt = new Date(item.played);
  if (!Number.isFinite(playedAt.getTime())) return null;

  const durationSec = parseDurationSeconds(item);
  const durationMs = durationSec ? durationSec * 1000 : undefined;
  const artist = joinArtists(item.artists);

  return {
    service: 'ytmusic',
    service_id: item.videoId,
    event_type: 'play',
    title: item.title,
    artist,
    album: item.album?.name,
    genres: [],
    duration_ms: durationMs,
    played_ms: durationMs,
    completed: true,
    played_at: item.played,
    metadata: {
      video_id: item.videoId,
      video_url: item.videoId ? `https://music.youtube.com/watch?v=${item.videoId}` : undefined,
      video_type: item.videoType,
      album_id: item.album?.id,
      artist_ids: item.artists?.map((a) => a.id).filter(Boolean),
      thumbnail: item.thumbnails?.[0]?.url,
      like_status: item.likeStatus,
      feedback_token: item.feedbackToken,
      played_raw: item.played_raw,
      played_precision: item.played_precision,
      played_bucket: item.played_bucket,
      played_bucket_start: item.played_bucket_start,
      played_bucket_end: item.played_bucket_end,
      played_cursor_eligible: item.played_cursor_eligible,
    },
  };
}
