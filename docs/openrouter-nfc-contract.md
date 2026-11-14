# Qwen4B NFC and empty-document contract

The semantic profile `total-recall/qwen3-4b-q8/paragraph256-utf8/v3` explicitly applies the pinned upstream tokenizer's **NFC** normalizer before local tokenization and both local/hosted inference. This is independent of operational manifest version 2.

- Upstream revision: `5cf2132abc99cad020ac570b19d031efec650f2b`.
- [Pinned tokenizer.json](https://huggingface.co/Qwen/Qwen3-Embedding-4B/resolve/5cf2132abc99cad020ac570b19d031efec650f2b/tokenizer.json) SHA-256: `83cdf8c3a34f68862319cb1810ee7b1e2c0a44e0864ae930194ddb76bb7feb8d`; its normalizer is `{"type":"NFC"}`.
- Semantic contract ID: `d38fb12a30cbd3a47a4f683b714779353d9dff6c6954f3c66e910909fbd1803d`.
- GGUF, native/stored dimensions, projection, fixed query-prefix bytes, input limits, provider identity, no-fallback policy and exact hosted token accounting are unchanged.

## Why raw Unicode was not interoperable

Actual CPU-only Qwen4B and DeepInfra public-fixture tests found that decomposed accents were not normalized by the pinned llama.cpp tokenizer. For a mixed Unicode fixture, local/hosted token counts were 30/29 and cosine was 0.995402. Its NFC form gave 29/29 tokens and cosine 0.999519. The isolated decomposed `e` plus combining acute gave 3/2 tokens and cosine 0.895088; the precomposed form gave 2/2 tokens and cosine 0.999791. The exact token-accounting guard correctly blocked the raw profile. It was not relaxed.

## Empty document representation

Actual hosted isolation rejects a raw empty document with HTTP 400 while accepting whitespace-only documents and the literal `[Blank document]`. Version 3 therefore pins `emptyDocumentInput` to `[Blank document]` for **only** an empty document. Queries and every nonempty document retain their version-2 wire representation, including all whitespace. The canonical empty source, hash, one empty chunk and zero-length UTF-8 offsets remain unchanged; its token count and vector measure the explicit derived input. This extends hosted coverage without deleting parents, inserting canonical text, accepting failed requests or relaxing any resource/compatibility guard. The new semantic ID requires a fresh target, never relabeling v2 vectors.

## Source integrity and wire behavior

Canonical memories, document text, chunk text, source/chunk hashes and UTF-8 source offsets remain **byte-for-byte raw**. Only the derived tokenizer/inference representation is NFC. Both query and document paths use the same normalizer; whitespace and query-prefix bytes are preserved. Chunk planning measures that representation but retains canonical ranges. If NFC expansion exceeds the existing 1 MiB tokenizer-content bound, the candidate is split before transport; final persisted token counts are measured, not estimated.

The gateway rejects non-NFC tokenizer or embedding payloads with HTTP 400 `gateway.text_normalization` before upstream work. Clients normalize raw planning input and inference input consistently. The old raw semantic profile is incompatible: create a fresh target contract/run and never relabel existing vectors or manifests.

Regression tests cover document/query formatting, both adapters, gateway rejection, exact canonical reconstruction and normalization expansion without widening byte limits. A production acceptance still requires actual bounded-runtime/public-fixture compatibility, complete private retrieval/security gates, convergence and rollback evidence; these unit tests alone do not authorize cutover.
