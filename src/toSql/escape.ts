export const escapeIdentifier = (identifier: string): string =>
  `"${identifier.replace(/"/g, '""')}"`;
