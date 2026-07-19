// Mirror msgvault's mcp.NewToolResultText / mcp.NewToolResultError: every tool
// returns a single text content block; errors additionally set isError.
export function jsonResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

export function errorResult(msg) {
  return { content: [{ type: 'text', text: msg }], isError: true };
}
