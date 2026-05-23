import { BaseConnector } from '../base.js';
import type { MediaEventInput } from '../../media.js';
import { getValidAccessToken } from './auth.js';
import { toMediaEvent, type PlayHistoryObject } from './transform.js';

const RECENTLY_PLAYED_URL = 'https://api.spotify.com/v1/me/player/recently-played';

export class SpotifyConnector extends BaseConnector {
  readonly service = 'spotify';

  protected async fetchSince(since: Date | null): Promise<{
    events: MediaEventInput[];
    cursor?: string;
  }> {
    const accessToken = await getValidAccessToken();

    const url = new URL(RECENTLY_PLAYED_URL);
    url.searchParams.set('limit', '50');
    if (since) {
      // Spotify uses ms since epoch for the `after` cursor
      url.searchParams.set('after', String(since.getTime()));
    }

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      throw new Error(`Spotify recently-played failed: ${res.status} ${await res.text()}`);
    }

    const data = await res.json() as {
      items: PlayHistoryObject[];
      cursors?: { after?: string; before?: string };
    };

    const events = (data.items ?? []).map(toMediaEvent);
    return { events, cursor: data.cursors?.after };
  }
}
