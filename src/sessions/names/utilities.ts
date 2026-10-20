/** Suggests a short, editable ASCII label without treating it as a session identity. */
export const suggestThreadName = (topic: string): string =>
  topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '') || 'session';

/** Adds an ordinal while keeping the complete label within the native-facing limit. */
export const suffixThreadName = (name: string, ordinal: number): string => {
  const suffix = `-${ordinal}`;
  return `${name.slice(0, 32 - suffix.length).replace(/-+$/g, '')}${suffix}`;
};
