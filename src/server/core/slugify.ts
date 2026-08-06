export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const COMBINING_MARKS_RE = /[\u0300-\u036f]/g;

/**
 * Title → slug: lowercased, accents stripped, anything outside a-z0-9
 * collapsed to single dashes, no leading/trailing dash.
 * Throws when the result is empty (e.g. title made only of symbols).
 */
export function slugify(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(COMBINING_MARKS_RE, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug === "") {
    throw new Error(`title "${title}" produces an empty slug`);
  }
  return slug;
}
