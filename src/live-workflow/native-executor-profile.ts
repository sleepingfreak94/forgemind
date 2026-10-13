import { realpathSync } from 'node:fs';
const literal = (p: string) => `(literal ${JSON.stringify(p)})`;
/** No process-fork, native project access, arbitrary egress, or ambient credential reads. */
export function nativeInferenceProfile(executable: string, home: string, tmp: string, port: number, dependencies: readonly string[]): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid native tunnel port');
  for (const path of [executable, home, tmp, ...dependencies])
    if (realpathSync(path) !== path || path.includes('\0')) throw new Error('Canonical native paths required');
  return `(version 1)
(deny default)
(allow process-exec ${literal(executable)})
(allow process-info* (target same-sandbox))
(allow sysctl-read)
(allow file-read-metadata)
(allow file-read* (literal "/") (subpath "/usr/lib") (subpath "/System/Library") (literal "/dev/null") ${[executable, ...dependencies].map(literal).join(' ')} (subpath ${JSON.stringify(home)}) (subpath ${JSON.stringify(tmp)}))
(allow file-write* (subpath ${JSON.stringify(home)}) (subpath ${JSON.stringify(tmp)}))
(allow mach-lookup (global-name "com.apple.trustd.agent") (global-name "com.apple.trustd"))
(allow file-read-data (literal "/private/etc/ssl/cert.pem"))
(allow mach-lookup (global-name "com.apple.cfprefsd.agent") (global-name "com.apple.cfprefsd.daemon"))
(allow ipc-posix-shm-read* (ipc-posix-name "apple.cfprefs.${process.getuid!()}v1") (ipc-posix-name "apple.cfprefs.daemonv1"))
(allow user-preference-read (preference-domain "com.openai.codex"))
(allow file-read-data (literal "/private/etc/codex/requirements.toml") (literal "/private/etc/codex/managed_config.toml") (literal "/private/etc/codex/config.toml"))
(allow network-outbound (remote ip "localhost:${port}"))`;
}
