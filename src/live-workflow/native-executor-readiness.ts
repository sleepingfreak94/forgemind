import { assertNativeHost } from './native-executor-host.js';
import type { FixtureNativeHost } from './native-executor-host.js';
import { unavailableNativeMetrics } from './native-executor-contracts.js';
export function nativeReadiness(host: FixtureNativeHost, mode: 'offline' | 'live', acceptedBudget: boolean) {
  assertNativeHost(host); host.boundary();
  return { ready: mode === 'offline', qualification: host.qualification, acceptedBudget,
    reasons: mode === 'live' ? ['No qualified live host boundary', ...(!acceptedBudget ? ['Native budget contract acceptance required'] : [])] : [],
    observed: ['tokenUsage'], unavailable: [...unavailableNativeMetrics] };
}
