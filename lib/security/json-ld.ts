const JSON_LD_ESCAPE_PATTERN = /[<>&\u2028\u2029]/g;
const JSON_LD_ESCAPES: Record<string, string> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

/** Serializes JSON for an HTML script element without allowing script closure. */
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(
    JSON_LD_ESCAPE_PATTERN,
    (character) => JSON_LD_ESCAPES[character] ?? character,
  );
}
