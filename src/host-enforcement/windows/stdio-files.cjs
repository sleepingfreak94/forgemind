// Preload (`node -r`) for the contained Cursor CLI on Windows (ADR-0017 phase 2b). Node with libuv < 1.53 loops forever
// inside an AppContainer when it spawns a child with stdio pipes (libuv names them outside LOCAL\; fixed in libuv
// 2cadaa401670). This routes piped stdout/stderr through temp files and replays them before 'close'; async stdin pipes
// become 'ignore' (writes are discarded), spawnSync input goes through a file. 'ipc' and extra pipes (fork) would hang,
// so they fail at once instead.
// shortcut: output arrives when the child exits, not streamed; delete this file once Cursor's Node bundles libuv >= 1.53.
'use strict';
const cp = require('child_process'), crypto = require('crypto'), fs = require('fs'), os = require('os'), path = require('path'), { PassThrough } = require('stream');
// os.tmpdir() follows TEMP. Inside an AppContainer Windows sets it to the container's own AC\Temp, which only that
// container can write; names are random and opened exclusively ('wx+').
const tempFile = (i) => path.join(os.tmpdir(), `fm-stdio-${process.pid}-${counter++}-${crypto.randomBytes(8).toString('hex')}-${i}`);
// Patched on ChildProcess so spawn, execFile, exec and fork (which use the module-internal spawn) all go through it.
const spawn = cp.ChildProcess.prototype.spawn;
// The container's AC\Temp outlives runs: remove files left by processes that are gone (a killed run), so the next run
// in the same container never reads another run's child output. Files of live processes (this run's) stay.
for (const name of (() => { try { return fs.readdirSync(os.tmpdir()); } catch { return []; } })()) {
  const pid = Number(/^fm-stdio-(\d+)-/.exec(name)?.[1]);
  if (!pid || pid === process.pid) continue;
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') fs.rmSync(path.join(os.tmpdir(), name), { force: true }); }
}
let counter = 0;
const piped = (s) => s === undefined || s === null || s === 'pipe' || s === 'overlapped';
cp.ChildProcess.prototype.spawn = function (options) {
  const stdio = typeof options.stdio === 'string' || options.stdio === undefined ? Array(3).fill(options.stdio ?? 'pipe') : [...options.stdio];
  while (stdio.length < 3) stdio.push('pipe');
  if (stdio.slice(3).some(piped) || stdio.includes('ipc')) throw new Error('stdio-files: ipc and extra stdio pipes cannot run inside the AppContainer');
  if (!stdio.slice(0, 3).some(piped)) return spawn.call(this, options);
  const files = [], streams = [];
  for (const i of [0, 1, 2]) {
    if (!piped(stdio[i])) continue;
    streams[i] = new PassThrough();
    if (i === 0) { stdio[0] = 'ignore'; continue; }
    const name = tempFile(i);
    files[i] = { name, fd: fs.openSync(name, 'wx+') };
    stdio[i] = files[i].fd;
  }
  const child = this;
  let error;
  try { error = spawn.call(this, { ...options, stdio }); }
  finally { files.forEach((f) => f && fs.closeSync(f.fd)); }
  // A failed spawn emits 'error' and never 'exit'; like Node, end the streams and close with the errno after the error.
  if (error) {
    files.forEach((f) => f && fs.rmSync(f.name, { force: true }));
    process.nextTick(() => { streams.forEach((s) => s && s.end()); setImmediate(() => emit.call(child, 'close', error, null)); });
  }
  for (const i of [0, 1, 2]) if (streams[i]) { child.stdio[i] = streams[i]; child[['stdin', 'stdout', 'stderr'][i]] = streams[i]; }
  const emit = child.emit;
  child.emit = function (event, ...rest) {
    if (event === 'close') return true; // re-emitted once the files are replayed
    if (event !== 'exit') return emit.call(this, event, ...rest);
    const result = emit.call(this, event, ...rest);
    const ends = [1, 2].filter((i) => streams[i]).map((i) => new Promise((resolve) => {
      let data = Buffer.alloc(0);
      try { data = fs.readFileSync(files[i].name); fs.rmSync(files[i].name, { force: true }); } catch {}
      streams[i].once('end', resolve);
      streams[i].end(data);
      if (streams[i].readableFlowing !== true && streams[i].listenerCount('data') === 0 && streams[i].listenerCount('readable') === 0) setImmediate(resolve);
    }));
    streams[0]?.end();
    Promise.all(ends).then(() => emit.call(this, 'close', ...rest));
    return result;
  };
  return error;
};

// spawnSync (and execFileSync/execSync, which call the module-internal spawnSync) use the same libuv pipes.
const spawnSync = cp.spawnSync;
cp.spawnSync = function (file, args, options) {
  if (!Array.isArray(args)) { options = args; args = []; }
  options = { ...(options || {}) };
  const stdio = typeof options.stdio === 'string' || options.stdio === undefined ? Array(3).fill(options.stdio ?? 'pipe') : [...options.stdio];
  while (stdio.length < 3) stdio.push('pipe');
  if (stdio.slice(3).some(piped) || stdio.includes('ipc')) throw new Error('stdio-files: ipc and extra stdio pipes cannot run inside the AppContainer');
  if (!stdio.slice(0, 3).some(piped)) return spawnSync.call(this, file, args, options);
  const files = [];
  for (const i of [0, 1, 2]) {
    if (!piped(stdio[i])) continue;
    if (i === 0 && options.input === undefined) { stdio[0] = 'ignore'; continue; }
    const name = tempFile(i);
    if (i === 0) fs.writeFileSync(name, options.input, { flag: 'wx' });
    files[i] = { name, fd: fs.openSync(name, i === 0 ? 'r' : 'wx+') };
    stdio[i] = files[i].fd;
  }
  delete options.input;
  try {
    const ret = spawnSync.call(this, file, args, { ...options, stdio });
    if (!ret.output) return ret; // e.g. ENOENT: Node leaves output null, as without the shim; a timeout keeps partial output
    for (const i of [1, 2]) if (files[i]) {
      const data = fs.readFileSync(files[i].name);
      ret.output[i] = ret[i === 1 ? 'stdout' : 'stderr'] = options.encoding && options.encoding !== 'buffer' ? data.toString(options.encoding) : data;
    }
    return ret;
  } finally { files.forEach((f) => { if (f) { fs.closeSync(f.fd); fs.rmSync(f.name, { force: true }); } }); }
};
const syncError = (ret, command) => {
  if (ret.error) throw ret.error;
  if (ret.status === 0 && ret.signal === null) return ret.stdout;
  const error = new Error(`Command failed: ${command}\n${ret.stderr ?? ''}`);
  Object.assign(error, { status: ret.status, signal: ret.signal, stdout: ret.stdout, stderr: ret.stderr, output: ret.output, pid: ret.pid });
  throw error;
};
// Like Node, stderr is captured (for the error) and, unless stdio was given, also written to the parent's stderr.
const execSync = (file, args, options, command) => {
  const ret = cp.spawnSync(file, args, options);
  if (!options.stdio && ret.stderr && ret.stderr.length) process.stderr.write(ret.stderr);
  return syncError(ret, command);
};
cp.execFileSync = function (file, args, options) {
  if (!Array.isArray(args)) { options = args; args = []; }
  return execSync(file, args, { ...(options || {}) }, [file, ...args].join(' '));
};
cp.execSync = function (command, options) {
  return execSync(command, [], { ...(options || {}), shell: options?.shell ?? true }, command);
};
