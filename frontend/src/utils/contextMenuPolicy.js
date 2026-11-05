export function getContextMenuPolicy(variant = 'inbox') {
  const gtdSidebar = variant === 'gtdSidebar';
  // The conversation pane has no list row behind it, so there is nothing to select.
  const conversation = variant === 'conversation';
  return {
    select: !gtdSidebar && !conversation,
    compose: true,
    archive: !gtdSidebar,
    snooze: !gtdSidebar,
    categorize: !gtdSidebar,
    tags: !gtdSidebar,
    done: gtdSidebar,
    rules: true,
    spam: !gtdSidebar,
    copy: true,
    viewHeaders: true,
  };
}

export function resolveContextMenuMessage(message, variant, resolveMessage) {
  if (variant !== 'gtdSidebar') return Promise.resolve(message);
  return resolveMessage(message.message_id || message.id, message.account_id);
}
