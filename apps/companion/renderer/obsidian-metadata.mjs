/** Allowlisted, aggregate-only Obsidian snapshot. No titles, paths or content. */
export const OBSIDIAN_SCHEMA = 'haloflux.obsidian.metadata.v1';

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 50_000_000 ? value : null;
}

export function parseObsidianMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== OBSIDIAN_SCHEMA) return null;
  const notes = count(value.notes);
  const links = count(value.links);
  const folders = count(value.folders);
  if (notes === null || links === null || folders === null) return null;
  const generatedAt = typeof value.generatedAt === 'string' && !Number.isNaN(Date.parse(value.generatedAt))
    ? new Date(value.generatedAt).toISOString()
    : null;
  return Object.freeze({ notes, links, folders, generatedAt, source: 'local-user-import', mode: 'static-snapshot' });
}
