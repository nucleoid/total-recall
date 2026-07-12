import type { MediaEventInput } from '../../media.js';

interface SpotifyImage {
  url: string;
  height?: number;
  width?: number;
}

interface SpotifyArtist {
  id: string;
  name: string;
  uri: string;
}

interface SpotifyAlbum {
  id: string;
  name: string;
  uri: string;
  release_date?: string;
  release_date_precision?: 'year' | 'month' | 'day';
  album_type?: string;
  images?: SpotifyImage[];
}

interface SpotifyTrack {
  id: string;
  uri: string;
  name: string;
  duration_ms: number;
  explicit?: boolean;
  popularity?: number;
  artists: SpotifyArtist[];
  album: SpotifyAlbum;
  external_urls?: { spotify?: string };
  external_ids?: { isrc?: string };
}

interface SpotifyContext {
  uri: string;
  type: string;
  external_urls?: { spotify?: string };
}

export interface PlayHistoryObject {
  track: SpotifyTrack;
  played_at: string;
  context: SpotifyContext | null;
}

function parseYear(release_date?: string): number | undefined {
  if (!release_date) return undefined;
  const m = release_date.match(/^(\d{4})/);
  return m ? parseInt(m[1], 10) : undefined;
}

export function toMediaEvent(item: PlayHistoryObject): MediaEventInput {
  const track = item.track;
  const primaryArtist = track.artists?.[0]?.name;
  const allArtists = track.artists?.map((a) => a.name).filter(Boolean) ?? [];

  return {
    service: 'spotify',
    service_id: track.uri,                     // e.g. spotify:track:7oK9QSKTYqA
    event_type: 'play',
    title: track.name,
    artist: allArtists.length > 1 ? allArtists.join(', ') : primaryArtist,
    album: track.album?.name,
    year: parseYear(track.album?.release_date),
    genres: [],                                // not in this endpoint; could enrich later
    duration_ms: track.duration_ms,
    played_at: item.played_at,
    metadata: {
      track_id: track.id,
      track_url: track.external_urls?.spotify,
      isrc: track.external_ids?.isrc,
      explicit: track.explicit,
      popularity: track.popularity,
      album_id: track.album?.id,
      album_type: track.album?.album_type,
      album_image: track.album?.images?.[0]?.url,
      artist_ids: track.artists?.map((a) => a.id),
      context_type: item.context?.type,
      context_uri: item.context?.uri,
    },
  };
}
