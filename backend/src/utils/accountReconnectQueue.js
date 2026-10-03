import { createKeyedSerializer } from './keyedSerializer.js';

// Account edits and admin proxy changes must not race disconnect→connect.
export const reconnectQueue = createKeyedSerializer();
