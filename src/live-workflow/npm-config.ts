import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

/** Snapshot-only exception for the two public security settings used by REBOS.
 * Never evaluate npm syntax, interpolate variables, or include unknown values. */
export function readPublicNpmConfig(path: string): Buffer {
  let fd: number | undefined;
  const reject = () => new Error('Unsafe public npm config');
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096) throw reject();
    const buffer = Buffer.alloc(4097);
    let length = 0, count: number;
    while (length < buffer.length && (count = readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += count;
    if (length > 4096) throw reject();
    const bytes = buffer.subarray(0, length), text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw reject();
    const seen = new Set<string>();
    for (const line of text.split(/\r?\n/)) {
      if (/^[\t ]*$/.test(line)) continue;
      const match = /^[\t ]*(ignore-scripts|audit)[\t ]*=[\t ]*true[\t ]*$/.exec(line);
      if (!match || seen.has(match[1]!)) throw reject();
      seen.add(match[1]!);
    }
    if (!seen.size) throw reject();
    return bytes;
  } catch {
    throw reject();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
