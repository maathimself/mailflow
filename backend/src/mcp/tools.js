import { jsonResult } from './result.js';
import {
  searchMetadataDef, handleSearchMetadata,
  searchMessageBodiesDef, handleSearchMessageBodies,
  semanticSearchMessagesDef, handleSemanticSearchMessages,
} from './searchTools.js';
import {
  getMessageDef, handleGetMessage,
  listMessagesDef, handleListMessages,
  getStatsDef, handleGetStats,
  aggregateDef, handleAggregate,
  searchByDomainsDef, handleSearchByDomains,
  findSimilarMessagesDef, handleFindSimilarMessages,
  searchInMessageDef, handleSearchInMessage,
  stageDeletionDef, handleStageDeletion,
} from './messageTools.js';

// TOOL_DEFS drives tools/list; HANDLERS drives tools/call. Slices 09 and 10
// append to both. Keep names, descriptions, and inputSchema field names verbatim
// from internal/mcp/server.go (README D6: id-bearing fields diverge to strings).
export const TOOL_DEFS = [
  {
    name: 'ping',
    description: 'Health check: returns {"pong":true}. Proves transport + auth round-trip.',
    inputSchema: { type: 'object', properties: {} },
  },
  searchMetadataDef,
  searchMessageBodiesDef,
  semanticSearchMessagesDef,
  getMessageDef,
  listMessagesDef,
  getStatsDef,
  aggregateDef,
  searchByDomainsDef,
  findSimilarMessagesDef,
  searchInMessageDef,
  stageDeletionDef,
];

export const HANDLERS = {
  // eslint-disable-next-line no-unused-vars
  ping: async (_args, _scope) => jsonResult({ pong: true }),
  search_metadata: (a, s) => handleSearchMetadata(a, s),
  search_message_bodies: (a, s) => handleSearchMessageBodies(a, s),
  semantic_search_messages: (a, s) => handleSemanticSearchMessages(a, s),
  get_message: (a, s) => handleGetMessage(a, s),
  list_messages: (a, s) => handleListMessages(a, s),
  get_stats: (a, s) => handleGetStats(a, s),
  aggregate: (a, s) => handleAggregate(a, s),
  search_by_domains: (a, s) => handleSearchByDomains(a, s),
  find_similar_messages: (a, s) => handleFindSimilarMessages(a, s),
  search_in_message: (a, s) => handleSearchInMessage(a, s),
  stage_deletion: (a, s) => handleStageDeletion(a, s),
};
