import type { CursorConfiguration } from './contracts.js';
import { DriverError } from './contracts.js';
import type { RpcReply } from './jsonl-rpc.js';
import { dataSnapshot, object, string } from '../context-engine/validation.js';

export const CURSOR_VERSION = '2026.07.09-a3815c0' as const;
export const cursorInitialize = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: 'forgemind', version: '0.1.0' } };
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DriverError('protocol-error');
  return value as Record<string, unknown>;
}
export function configurationSnapshot(raw: CursorConfiguration, model: string): CursorConfiguration {
  const config = dataSnapshot(raw); object(config, ['modelOptionId', 'modeOptionId', 'options']);
  string(config.modelOptionId, 128); string(config.modeOptionId, 128);
  if (config.modelOptionId === config.modeOptionId || !Array.isArray(config.options) || config.options.length < 2 || config.options.length > 8) throw new DriverError('invalid-input');
  const ids = new Set<string>();
  for (const setting of config.options) {
    object(setting, ['configId', 'value']); string(setting.configId, 128); string(setting.value, 256);
    if (ids.has(setting.configId)) throw new DriverError('invalid-input'); ids.add(setting.configId);
  }
  if (!config.options.some(s => s.configId === config.modelOptionId && s.value === model) ||
      !config.options.some(s => s.configId === config.modeOptionId && s.value === 'ask')) throw new DriverError('invalid-input');
  return config;
}
export function verifyInitialize(raw: unknown): void {
  const value = record(raw);
  if (value.protocolVersion !== 1) throw new DriverError('denied');
  record(value.agentCapabilities);
  if (!Array.isArray(value.authMethods) || value.authMethods.length > 16) throw new DriverError('protocol-error');
  // agentInfo is optional in ACP v1 and absent in the pinned native package.
}
export function configState(raw: unknown, selected: CursorConfiguration): Map<string, string> {
  if (!Array.isArray(raw) || raw.length > 32) throw new DriverError('denied');
  const state = new Map<string, string>();
  for (const setting of selected.options) {
    const matches = raw.map(record).filter(option => option.id === setting.configId);
    if (matches.length !== 1) throw new DriverError('denied');
    const option = matches[0]!; string(option.currentValue, 256);
    if (option.type !== 'select' || !Array.isArray(option.options) || option.options.length > 128) throw new DriverError('denied');
    const values = option.options.flatMap(raw => {
      const value = record(raw);
      return 'group' in value ? (Array.isArray(value.options) && value.options.length <= 128 ? value.options.map(record) : []) : [value];
    });
    if (values.length > 256 || !values.some(value => value.value === setting.value)) throw new DriverError('denied');
    state.set(setting.configId, option.currentValue);
  }
  return state;
}
export function verifyConfiguration(raw: unknown, selected: CursorConfiguration): void {
  const state = configState(raw, selected);
  if (selected.options.some(setting => state.get(setting.configId) !== setting.value)) throw new DriverError('denied');
}
export function denyCursorRequest(method: string, raw: unknown): RpcReply {
  if (method === 'session/request_permission') {
    const params = record(raw);
    if (Array.isArray(params.options)) for (const rawOption of params.options.slice(0, 32)) {
      const option = record(rawOption);
      if (['reject_once', 'reject_always'].includes(String(option.kind))) {
        string(option.optionId, 256); return { result: { outcome: { outcome: 'selected', optionId: option.optionId } } };
      }
    }
    return { result: { outcome: { outcome: 'cancelled' } } };
  }
  if (['cursor/ask_question', 'cursor/create_plan'].includes(method)) return { result: { outcome: { outcome: 'cancelled' } } };
  return { error: { code: -32601, message: 'Unsupported request' } };
}
