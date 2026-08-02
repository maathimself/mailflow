// Leaf module: imports nothing from vectorStore/hybrid so Phase 3's loadVector
// and Phase 5's MCP handlers can import this without a cycle.
export class VectorUnavailableError extends Error {
  constructor(reason) { super(reason); this.name = 'VectorUnavailableError'; this.reason = reason; }
}
