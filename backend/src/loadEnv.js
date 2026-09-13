import { config } from 'dotenv';

// Load .env before any module reads process.env. dotenv 17 logs every load with an
// advertising tip by default; quiet keeps the startup log clean.
config({ quiet: true });
