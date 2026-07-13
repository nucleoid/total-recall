// Tests exercise embedding consumers without making provider calls. Production still
// requires operators to configure this exact profile explicitly.
process.env.EMBEDDING_PROVIDER ??= 'gemini';
process.env.EMBEDDING_MODEL ??= 'gemini-embedding-2-preview';
process.env.EMBEDDING_DIMENSIONS ??= '768';
process.env.GEMINI_API_KEY ??= 'test-only-key';
