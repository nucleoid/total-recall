export interface Chunk {
  content: string;
  heading: string;
  sourceKey: string;
  tags: string[];
  metadata: Record<string, unknown>;
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

export function chunkMarkdown(content: string, source: string, relPath: string): Chunk[] {
  const { tags, body } = extractFrontmatter(content);
  const now = new Date().toISOString();
  const chunks: Chunk[] = [];
  const mkKey = (heading: string) => `file-sync:${relPath}:${heading}`;

  const sections = body.split(/^(## .+)$/m);

  if (sections.length <= 1) {
    const text = body.trim();
    if (!text || text.length < 10) return [];
    chunks.push({ content: text, heading: '(root)', sourceKey: mkKey('(root)'), tags, metadata: { file: relPath, heading: '(root)', synced_at: now } });
    return chunks;
  }

  const preamble = sections[0].trim();
  if (preamble && preamble.length >= 10) {
    chunks.push({ content: preamble, heading: '(preamble)', sourceKey: mkKey('(preamble)'), tags, metadata: { file: relPath, heading: '(preamble)', synced_at: now } });
  }

  for (let i = 1; i < sections.length; i += 2) {
    const heading = sections[i].trim();
    const sectionBody = (sections[i + 1] || '').trim();
    const fullContent = heading + '\n' + sectionBody;
    if (!sectionBody || sectionBody.length < 5) continue;

    if (fullContent.length > 2000) {
      const subSections = sectionBody.split(/^(### .+)$/m);
      if (subSections.length > 1) {
        const subPre = subSections[0].trim();
        if (subPre && subPre.length >= 10) {
          chunks.push({ content: heading + '\n' + subPre, heading, sourceKey: mkKey(heading), tags, metadata: { file: relPath, heading, synced_at: now } });
        }
        for (let j = 1; j < subSections.length; j += 2) {
          const subHeading = subSections[j].trim();
          const subBody = (subSections[j + 1] || '').trim();
          if (!subBody || subBody.length < 5) continue;
          const combined = `${heading} > ${subHeading}`;
          chunks.push({ content: heading + '\n' + subHeading + '\n' + subBody, heading: combined, sourceKey: mkKey(`${heading}:${subHeading}`), tags, metadata: { file: relPath, heading: combined, synced_at: now } });
        }
        continue;
      }
    }

    chunks.push({ content: fullContent, heading, sourceKey: mkKey(heading), tags, metadata: { file: relPath, heading, synced_at: now } });
  }
  return chunks;
}
