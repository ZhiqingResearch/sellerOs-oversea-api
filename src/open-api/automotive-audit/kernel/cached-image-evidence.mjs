// Migrated from the accepted automotive audit script; runtime I/O is injected by the service.
// These four immutable cached files were visually inspected locally on 2026-10-20.
// Bind the observation to bytes, never to ASIN or URL (which can change).
export const REVIEWED_TEXTLESS_IMAGES = new Set([
  '954e81e453190e0ab395311ad015aaf00b602738d0f656bd82820c88f6bab5c4',
  '868aa3c9d6ac647fb609faec8f46a345158e9afe8abf2bc357e229e4d64f9d17',
  '9ffbffc2cc8ea295ef8791325f4681f47a0be461804353555621ee445cceed89',
  '1aecb4e024657830d55f99a7b24647d9a20abba4965763bf3c332ab3b6cc6941',
]);
export function hasImageTextEvidence(image, snapshot) {
  if (image.isReadable) return true;
  if (image.text?.trim()) return false;
  const metadata = snapshot?.images?.find(item => item.imageId === image.imageId);
  if (metadata?.sha256 && REVIEWED_TEXTLESS_IMAGES.has(metadata.sha256)) return true;
  return image.imageId === 'main:0' && snapshot?.review?.main?.hasOverlay === false &&
    Boolean(image.observation?.trim()) && !/模糊|不可辨|无法辨|无法识别|unreadable|blurred/i.test(image.observation);
}
