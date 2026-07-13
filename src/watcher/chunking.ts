import crypto from 'node:crypto';

export interface Chunk {
  content: string;
  heading: string;
  sourceKey: string;
  tags: string[];
  metadata: Record<string, unknown>;
}

function frame(value: string | null): Buffer {
  if (value === null) return Buffer.from([0, 0, 0, 0, 0]);
  const bytes = Buffer.from(value, 'utf8');
  const header = Buffer.alloc(5);
  header[0] = 1;
  header.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
}

/**
 * Preserve legacy identities for first occurrences. Later occurrences use a
 * versioned, length-prefixed tuple so arbitrary heading text cannot make two
 * structured paths serialize alike.
 */
export function buildSourceKey(
  relPath: string,
  h2: string,
  h2Occurrence: number,
  h3: string | null = null,
  h3Occurrence: number | null = null,
): string {
  if (!Number.isSafeInteger(h2Occurrence) || h2Occurrence < 1) {
    throw new Error(`Invalid H2 occurrence: ${h2Occurrence}`);
  }
  if ((h3 === null) !== (h3Occurrence === null)) {
    throw new Error('H3 heading and occurrence must either both be present or both be absent');
  }
  if (h3Occurrence !== null && (!Number.isSafeInteger(h3Occurrence) || h3Occurrence < 1)) {
    throw new Error(`Invalid H3 occurrence: ${h3Occurrence}`);
  }

  if (h2Occurrence === 1 && (h3Occurrence === null || h3Occurrence === 1)) {
    return `file-sync:${relPath}:${h3 === null ? h2 : `${h2}:${h3}`}`;
  }

  const canonical = Buffer.concat([
    Buffer.from('file-sync-key\0v2\0', 'utf8'),
    frame(relPath),
    frame(h2),
    frame(String(h2Occurrence)),
    frame(h3),
    frame(h3Occurrence === null ? null : String(h3Occurrence)),
  ]);
  return `file-sync:v2:${crypto.createHash('sha256').update(canonical).digest('hex')}`;
}

export function assertUniqueSourceKeys(chunks: ReadonlyArray<Pick<Chunk, 'sourceKey'>>): void {
  const seen = new Set<string>();
  for (const chunk of chunks) {
    if (seen.has(chunk.sourceKey)) {
      throw new Error(`Duplicate source key emitted while chunking file: ${chunk.sourceKey}`);
    }
    seen.add(chunk.sourceKey);
  }
}

export function extractFrontmatter(text: string): { tags: string[]; body: string } {
  const opening = /^---(?:\r\n|\n)/.exec(text);
  if (!opening) return { tags: [], body: text };

  const closing = /^---(?:\r\n|\n|$)/gm;
  closing.lastIndex = opening[0].length;
  const match = closing.exec(text);
  if (!match) return { tags: [], body: text };

  const frontmatter = text.slice(opening[0].length, match.index);
  const tagMatch = frontmatter.match(/tags:\s*\[([^\]]*)\]/);
  const tags = tagMatch
    ? tagMatch[1].split(',').map(t => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
    : [];
  return { tags, body: text.slice(match.index + match[0].length) };
}

function nextOccurrence(counts: Map<string, number>, heading: string): number {
  const occurrence = (counts.get(heading) ?? 0) + 1;
  counts.set(heading, occurrence);
  return occurrence;
}

export function chunkMarkdown(content: string, source: string, relPath: string): Chunk[] {
  const { tags, body } = extractFrontmatter(content);
  const now = new Date().toISOString();
  const chunks: Chunk[] = [];
  const mkLegacyKey = (heading: string) => `file-sync:${relPath}:${heading}`;

  const sections = body.split(/^(## .+)$/m);

  if (sections.length <= 1) {
    const text = body.trim();
    if (!text || text.length < 10) return [];
    chunks.push({ content: text, heading: '(root)', sourceKey: mkLegacyKey('(root)'), tags, metadata: { file: relPath, heading: '(root)', synced_at: now } });
    assertUniqueSourceKeys(chunks);
    return chunks;
  }

  const preamble = sections[0].trim();
  if (preamble && preamble.length >= 10) {
    chunks.push({ content: preamble, heading: '(preamble)', sourceKey: mkLegacyKey('(preamble)'), tags, metadata: { file: relPath, heading: '(preamble)', synced_at: now } });
  }

  const h2Counts = new Map<string, number>();
  for (let i = 1; i < sections.length; i += 2) {
    const heading = sections[i].trim();
    const h2Occurrence = nextOccurrence(h2Counts, heading);
    const sectionBody = (sections[i + 1] || '').trim();
    const fullContent = heading + '\n' + sectionBody;
    if (!sectionBody || sectionBody.length < 5) continue;

    const h2Metadata = { file: relPath, heading, h2_occurrence: h2Occurrence, synced_at: now };
    if (fullContent.length > 2000) {
      const subSections = sectionBody.split(/^(### .+)$/m);
      if (subSections.length > 1) {
        const subPre = subSections[0].trim();
        if (subPre && subPre.length >= 10) {
          chunks.push({
            content: heading + '\n' + subPre,
            heading,
            sourceKey: buildSourceKey(relPath, heading, h2Occurrence),
            tags,
            metadata: h2Metadata,
          });
        }
        const h3Counts = new Map<string, number>();
        for (let j = 1; j < subSections.length; j += 2) {
          const subHeading = subSections[j].trim();
          const h3Occurrence = nextOccurrence(h3Counts, subHeading);
          const subBody = (subSections[j + 1] || '').trim();
          if (!subBody || subBody.length < 5) continue;
          const combined = `${heading} > ${subHeading}`;
          chunks.push({
            content: heading + '\n' + subHeading + '\n' + subBody,
            heading: combined,
            sourceKey: buildSourceKey(relPath, heading, h2Occurrence, subHeading, h3Occurrence),
            tags,
            metadata: {
              file: relPath,
              heading: combined,
              h2_occurrence: h2Occurrence,
              h3_occurrence: h3Occurrence,
              synced_at: now,
            },
          });
        }
        continue;
      }
    }

    chunks.push({
      content: fullContent,
      heading,
      sourceKey: buildSourceKey(relPath, heading, h2Occurrence),
      tags,
      metadata: h2Metadata,
    });
  }
  assertUniqueSourceKeys(chunks);
  return chunks;
}
