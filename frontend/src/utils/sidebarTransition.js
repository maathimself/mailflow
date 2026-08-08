const SIDEBAR_TRANSITION_TIMING = '0.2s ease';

export function sidebarTransition(...properties) {
  return properties.map(property => `${property} ${SIDEBAR_TRANSITION_TIMING}`).join(', ');
}
