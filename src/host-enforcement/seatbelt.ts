import type { HostPlan } from './manifest.js';

// Static policy is part of version macos-offline-v2. No extensions or permissive fallback.
export function offlineProfile(plan: HostPlan, scratch: string): string {
  const literal = (path: string) => `(literal ${JSON.stringify(path)})`;
  return `(version 1)
(deny default)
(allow process-exec ${literal(plan.executable.path)})
(allow process-info* (target same-sandbox))
(allow sysctl-read)
(allow file-read-metadata)
(allow file-read* (literal "/") (subpath "/usr/lib") (subpath "/System/Library") (literal "/dev/null")
  ${literal(plan.intent.workspaceRoot)}
  ${[plan.executable, ...plan.readFiles].map(file => literal(file.path)).join('\n  ')}
  (subpath ${JSON.stringify(scratch)}))
(allow file-write* (subpath ${JSON.stringify(scratch)}))`;
}
