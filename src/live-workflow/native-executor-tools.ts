import { readFileSync, lstatSync } from 'node:fs';
import { safePath, sha256 } from './validation.js';
import { applyEdits } from './edits.js';
import type { NativeTask } from './native-executor-contracts.js';
import type { NativeState } from './native-executor-state.js';
import type { FixtureNativeHost } from './native-executor-host.js';
export const nativeDynamicTools = ['host_read', 'host_apply', 'host_check'].map(name => ({
  type: 'function', name, description: 'Owner bounded ' + name,
  inputSchema: { type: 'object', additionalProperties: false, properties: name === 'host_read' ? { path: { type: 'string' } } : name === 'host_check' ? { id: { type: 'string' } } : { summary: { type: 'string' }, edits: { type: 'array', items: { type: 'object' } } },
} }));
export async function nativeTool(task: NativeTask, state: NativeState, host: FixtureNativeHost, tool: string, args: unknown, signal: AbortSignal): Promise<string> {
  host.boundary(); signal.throwIfAborted();
  if (host.source() !== state.value.source) throw new Error('Stale native source');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Malformed tool arguments');
  const a = args as Record<string, unknown>;
  let result: unknown;
  if (tool === 'host_read') {
    if (Object.keys(a).join() !== 'path' || typeof a.path !== 'string' || !task.readPaths.includes(a.path)) throw new Error('Read outside exact grant');
    const path = safePath(task.root, a.path), stat = lstatSync(path);
    if (!stat.isFile() || stat.size > task.budget.resultBytes - state.value.counters.resultBytes) throw new Error('Read result limit');
    const receipt = host.authority.reserve({kind:'artifact', source:state.value.source, detail:{operation:'native.read',path:a.path,maxBytes:stat.size}});
    try { receipt.check(); host.boundary(); const content = readFileSync(path); result = { path: a.path, sha256: sha256(content), content: content.toString('utf8') }; receipt.finish('completed',sha256(content)); } catch(e) { receipt.finish('indeterminate'); throw e; }
  } else if (tool === 'host_apply') {
    state.update({ pending: 'files.apply' });
    result = applyEdits(task.root, state.value.source, task.writePaths, args, host.authority, () => { host.boundary(); signal.throwIfAborted(); });
    state.update({ source: host.source() });
  } else if (tool === 'host_check') {
    if (Object.keys(a).join() !== 'id' || typeof a.id !== 'string' || !task.checks.some(c => c.id === a.id)) throw new Error('Check outside exact grant');
    state.update({ pending: 'check' });
    const receipt = host.authority.reserve({kind:'command',source:state.value.source,detail:{operation:'native.predefined-check',command:task.checks.find(c=>c.id===a.id)}});
    try { receipt.check(); result = await host.check(a.id, signal); host.boundary(); receipt.check(); receipt.finish('completed',sha256(JSON.stringify(result))); } catch(e) { receipt.finish('indeterminate'); throw e; }
  } else throw new Error('Unknown native tool');
  host.boundary(); signal.throwIfAborted();
  const text = JSON.stringify(result); state.charge('resultBytes', Buffer.byteLength(text));
  state.update({ stage: tool, pending: null }); return text;
}
