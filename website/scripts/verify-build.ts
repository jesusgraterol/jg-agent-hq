import { fileURLToPath } from 'node:url';

import { verifyBuild } from '../src/build/index.ts';

await verifyBuild(fileURLToPath(new URL('../dist', import.meta.url)));
