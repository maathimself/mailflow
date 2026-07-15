/**
 * Public vCard API surface.
 *
 * Implementation lives in vcardDocument, vcardProjection, and vcardHashes.
 */
// Retained-document syntax and the shared server-owned property boundary.
export {
  ADR_COMPONENTS,
  SERVER_OWNED_PROPERTIES,
  parseVCardDocument,
  serializeVCardDocument,
} from './vcardDocument.js';
// Contact projection and retained-document overlay.
export {
  ADDITIONAL_PROPERTIES,
  allocateItemGroup,
  contactFromVCardDocument,
  groupKey,
  overlayContactOnVCard,
  presentedEtag,
  presentedVCard,
  primaryEmail,
  pushSafeSnapshot,
  withDocumentUid,
} from './vcardProjection.js';
// Remote-document semantic and local-contact hashes.
export {
  localContactHash,
  localVCardEtag,
  semanticVCardHash,
} from './vcardHashes.js';
