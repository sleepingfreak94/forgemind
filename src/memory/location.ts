import { homedir } from 'node:os';
import { join } from 'node:path';
/** Local owner state; never a directory under the repository or a provider credential store. */
export function defaultMemoryDirectory(): string { return join(homedir(), '.forgemind', 'memory'); }
