import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { nativeWorkerMain, writeNativeCliFailure } from './native-cli.js';
if(process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url))nativeWorkerMain().catch(writeNativeCliFailure);
