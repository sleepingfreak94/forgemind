import { assertNativeHost, nativeHostEvidence } from './native-executor-host.js';
import type { NativeHost } from './native-executor-host.js';
import { unavailableNativeMetrics } from './native-executor-contracts.js';
export function nativeReadiness(host: NativeHost, mode: 'offline' | 'live', acceptedBudget: boolean) {
  assertNativeHost(host); host.boundary();
  const evidence=nativeHostEvidence(host);
  const qualified=host.qualification==='native-seatbelt' && evidence!==null;
  return { ready: mode==='offline' || (qualified && acceptedBudget), qualification:host.qualification,
    acceptedBudget,evidence,reasons:mode==='live'?[
      ...(!qualified?['No qualified live host boundary']:[]),
      ...(!acceptedBudget?['Native budget contract acceptance required']:[]),
    ]:[],observed:['tokenUsage'],unavailable:[...unavailableNativeMetrics] };
}
