import type { ActionRequest } from '../policy/contracts.js';

/** Deterministic reference adapter. No filesystem, process, network or provider effects. */
export class FakeAdapter {
  readonly #calls: Readonly<ActionRequest>[] = [];
  readonly #files = new Map<string, string>();
  get calls(): readonly Readonly<ActionRequest>[] { return [...this.#calls]; }
  read(path: string): string | undefined { return this.#files.get(path); }
  execute(request: Readonly<ActionRequest>): void {
    this.#calls.push(Object.freeze({ ...request }));
    if (request.action === 'command.run' && request.resource === 'test:fail') throw new Error('deterministic fake failure');
    if (request.action === 'file.write') this.#files.set(request.resource, request.content!);
  }
}
