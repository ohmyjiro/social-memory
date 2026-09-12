export const CAPTURE_KINDS = Object.freeze(['like', 'save', 'repost', 'manual']);

const captureKindSet = new Set(CAPTURE_KINDS);

export function validateCaptureKinds(kinds, supportedKinds) {
  if (!Array.isArray(kinds) || kinds.length === 0) {
    throw new Error('Select at least one capture kind');
  }

  const seen = new Set();
  for (const kind of kinds) {
    if (!captureKindSet.has(kind)) throw new Error(`Unknown capture kind: ${kind}`);
    if (seen.has(kind)) throw new Error(`Duplicate capture kind: ${kind}`);
    if (!supportedKinds.includes(kind)) {
      throw new Error(`Connector does not support capture kind: ${kind}`);
    }
    seen.add(kind);
  }

  return CAPTURE_KINDS.filter((kind) => seen.has(kind));
}
