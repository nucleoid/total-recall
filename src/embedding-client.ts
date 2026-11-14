export interface EmbeddingResult {
  vectors: number[][];
  tokens: number[];
}

export interface EmbeddingClient {
  countFormattedTokens(formatted: string, signal?: AbortSignal): Promise<number>;
  embed(texts: string[], role: 'document' | 'query', signal?: AbortSignal): Promise<EmbeddingResult>;
}
