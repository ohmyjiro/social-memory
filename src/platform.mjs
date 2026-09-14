export function platformForConnector(id) {
  if (['x', 'x-aside', 'x-chrome'].includes(id)) return 'x';
  if (['threads', 'threads-chrome'].includes(id)) return 'threads';
  return id;
}

export function normalizedIdentity(platform, identity) {
  const value = String(identity ?? '').trim();
  return ['x', 'threads'].includes(platform) ? value.replace(/^@/, '').toLowerCase() : value;
}
