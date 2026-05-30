import { getConnectorCredentials, setConnectorCredentials } from '../../media.js';

const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';

export const SPOTIFY_SCOPES = [
  'user-read-recently-played',
  'user-read-playback-position',
  'user-read-currently-playing',
  'user-top-read',
];

export interface SpotifyCreds {
  access_token: string;
  refresh_token: string;
  expires_at: number;            // epoch ms
  scope: string;
  token_type: string;
}

function getClientConfig(): { clientId: string; clientSecret: string; redirectUri: string } {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  const redirectUri = process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:8888/callback';
  if (!clientId || !clientSecret) {
    throw new Error('SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set in the environment');
  }
  return { clientId, clientSecret, redirectUri };
}

export function buildAuthorizeUrl(state: string): string {
  const { clientId, redirectUri } = getClientConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SPOTIFY_SCOPES.join(' '),
    state,
    show_dialog: 'true',
  });
  return `${SPOTIFY_AUTHORIZE_URL}?${params.toString()}`;
}

function basicAuthHeader(): string {
  const { clientId, clientSecret } = getClientConfig();
  return 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

export async function exchangeCodeForTokens(code: string): Promise<SpotifyCreds> {
  const { redirectUri } = getClientConfig();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });

  const res = await fetch(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuthHeader(),
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`Spotify token exchange failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope: string;
    token_type: string;
  };

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in - 60) * 1000,
    scope: data.scope,
    token_type: data.token_type,
  };
}

async function refreshAccessToken(refreshToken: string): Promise<Pick<SpotifyCreds, 'access_token' | 'refresh_token' | 'expires_at' | 'scope' | 'token_type'>> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const res = await fetch(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuthHeader(),
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`Spotify token refresh failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
    token_type: string;
  };

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? refreshToken,
    expires_at: Date.now() + (data.expires_in - 60) * 1000,
    scope: data.scope,
    token_type: data.token_type,
  };
}

/**
 * Returns a valid access token, refreshing if needed and persisting the new
 * credentials. Throws if no creds exist (run scripts/spotify-auth.ts first).
 */
export async function getValidAccessToken(): Promise<string> {
  const stored = await getConnectorCredentials('spotify') as SpotifyCreds | null;
  if (!stored?.refresh_token) {
    throw new Error('No Spotify credentials stored. Run scripts/spotify-auth.ts to authorize.');
  }

  if (stored.access_token && stored.expires_at && stored.expires_at > Date.now()) {
    return stored.access_token;
  }

  const refreshed = await refreshAccessToken(stored.refresh_token);
  await setConnectorCredentials('spotify', { ...stored, ...refreshed });
  return refreshed.access_token;
}

export async function saveInitialCreds(creds: SpotifyCreds): Promise<void> {
  await setConnectorCredentials('spotify', creds as unknown as Record<string, unknown>);
}
