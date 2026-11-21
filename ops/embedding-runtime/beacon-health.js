import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
export const BEACON_HOST = 'beacon-chain.lodestar.dappnode.private';
export const BEACON_URL = `http://${BEACON_HOST}:3500/eth/v1/node/syncing`;
const resolver = new Resolver({timeout:1500,tries:1});
resolver.setServers(['172.33.1.2']);
const privateAddress = address => isIP(address) === 4 && (address.startsWith('10.') || address.startsWith('192.168.') || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(address));
export async function fetchBeaconResponse(beaconUrl=BEACON_URL, options={}) {
  const url = new URL(beaconUrl);
  if (url.protocol!=='http:' || url.hostname!==BEACON_HOST || url.port!=='3500' || url.pathname!=='/eth/v1/node/syncing' || url.username || url.password || url.search || url.hash) throw Error('beacon.endpoint');
  const addresses = await (options.resolve ?? (host => resolver.resolve4(host)))(BEACON_HOST);
  if (!Array.isArray(addresses) || addresses.length!==1 || !privateAddress(addresses[0])) throw Error('beacon.address');
  url.hostname=addresses[0];
  return (options.fetch ?? fetch)(url.toString(),{signal:AbortSignal.timeout(3000),redirect:'error'});
}
export async function fetchBeaconHealth() {
  const response=await fetchBeaconResponse();
  if(!response.ok)throw Error('beacon.http');
  const body=await response.json();const d=body?.data;
  if(!d || d.is_syncing!==false || d.is_optimistic!==false || d.el_offline!==false || !/^[0-9]+$/.test(String(d.sync_distance)) || Number(d.sync_distance)>2)throw Error('beacon.unhealthy');
  return d;
}
