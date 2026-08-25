export function selectDraftOperation(previous, payload, createKey) {
  const payloadIdentity = JSON.stringify(payload);
  if (previous?.payloadIdentity === payloadIdentity) return previous;
  return { key: createKey(), payloadIdentity };
}

export function selectSendOperation(previous, payload, createKey) {
  const payloadIdentity = JSON.stringify(payload);
  if (!previous) {
    return { key: createKey(), payloadIdentity, rotateOnPayloadChange: false };
  }
  if (previous.payloadIdentity === payloadIdentity) return previous;
  if (previous.rotateOnPayloadChange) {
    return { key: createKey(), payloadIdentity, rotateOnPayloadChange: false };
  }
  return previous;
}

export function recordSendFailure(operation, error) {
  if (!operation) return operation;
  return {
    ...operation,
    rotateOnPayloadChange:
      error?.operationKeyDisposition === 'rotate_on_payload_change',
  };
}
