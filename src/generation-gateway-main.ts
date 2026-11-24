import { generationGatewayConfigFromEnv, listenGenerationGateway } from './generation-gateway-adapter.js';
const config = generationGatewayConfigFromEnv(process.env);
listenGenerationGateway(config).then(server => {
  console.log(`[generation-gateway] listening on ${config.host}:${config.port}`);
  const stop=()=>server.close(error=>{if(error)console.error('[generation-gateway] shutdown failed');});
  process.once('SIGINT',stop); process.once('SIGTERM',stop);
}).catch(error=>{console.error('[generation-gateway] failed:',error instanceof Error?error.message:'unknown error');process.exitCode=1;});
