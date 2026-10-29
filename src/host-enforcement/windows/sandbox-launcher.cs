// ForgeMind Windows sandbox launcher (ADR-0017). The owner builds it once with the in-box C# 5 compiler
// (scripts/build-windows-launcher.mjs) and the host pins the binary by hash; it is never compiled at run time.
//   launcher run <base64url policy JSON>   run one command in a fresh AppContainer inside a kill-on-close job
//   launcher sweep <journal directory>     remove grants and profiles left by a launcher that was killed
//   launcher setup <directory>...          once, as administrator: let contained runs read the attributes of each
//                                          directory and its ancestors (Node's realpath stats every path component)
// Child output goes to the inherited stdio; the trusted result goes only to policy.reportPath, which the child cannot open.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

public class Policy {
  public string executable { get; set; }
  public string[] args { get; set; }
  public string cwd { get; set; }
  public Dictionary<string, string> env { get; set; }
  public string[] readPaths { get; set; }
  public string[] writePaths { get; set; }
  public string[] denyPaths { get; set; }
  public int timeoutMs { get; set; }
  public int activeProcessLimit { get; set; }
  public string reportPath { get; set; }
  public string journalPath { get; set; }
}

public class Journal {
  public string name { get; set; }
  public string sid { get; set; }
  public string[] trees { get; set; }
  public string[] objects { get; set; }
}

static class Launcher {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
    public BasicLimit Basic; public IoCounters Io;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
    public int cb; public string lpReserved, lpDesktop, lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
  [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] struct SidAndAttributes { public IntPtr Sid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct SecurityCapabilities { public IntPtr AppContainerSid, Capabilities; public uint CapabilityCount, Reserved; }

  [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int CreateAppContainerProfile(string name, string display, string description, IntPtr capabilities, uint count, out IntPtr sid);
  [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
  [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
  [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, IntPtr name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimit info, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref uint info, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out Accounting info, int size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcess(string application, StringBuilder commandLine,
    IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string cwd, ref StartupInfoEx startup, out ProcessInformation info);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetThreadDesktop(uint thread);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("advapi32.dll")] static extern int GetSecurityInfo(IntPtr handle, int type, int info, IntPtr owner, IntPtr group, out IntPtr dacl, IntPtr sacl, out IntPtr descriptor);
  [DllImport("advapi32.dll")] static extern int SetSecurityInfo(IntPtr handle, int type, int info, IntPtr owner, IntPtr group, byte[] dacl, IntPtr sacl);
  [DllImport("advapi32.dll")] static extern int GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("kernelbase.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool DeriveCapabilitySidsFromName(string name,
    out IntPtr groupSids, out uint groupCount, out IntPtr sids, out uint count);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateFile(string name, uint access, uint share,
    IntPtr attributes, uint disposition, uint flags, IntPtr template);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetKernelObjectSecurity(IntPtr handle, int info, byte[] descriptor, int length, out int needed);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetKernelObjectSecurity(IntPtr handle, int info, byte[] descriptor);

  const uint KillOnJobClose = 0x2000, DieOnUnhandledException = 0x400, ActiveProcess = 0x8;
  const uint ExtendedStartupInfoPresent = 0x80000, CreateSuspended = 0x4, UnicodeEnvironment = 0x400, DetachedProcess = 0x8;
  static readonly JavaScriptSerializer json = new JavaScriptSerializer();

  static int Main(string[] argv) {
    try {
      if (argv.Length == 2 && argv[0] == "run") return Run(json.Deserialize<Policy>(Encoding.UTF8.GetString(FromBase64Url(argv[1]))));
      if (argv.Length == 2 && argv[0] == "sweep") return Sweep(argv[1]);
      if (argv.Length >= 2 && argv[0] == "setup") return Setup(argv);
      Console.Error.WriteLine("forgemind-launcher: usage: run <policy> | sweep <journal directory> | setup <directory>...");
      return 64;
    } catch (Exception error) {
      // Reached only before the report exists (or if writing it failed), so the host treats the run as unconfirmed.
      Console.Error.WriteLine("forgemind-launcher: " + error.GetType().Name + ": " + error.Message);
      return 70;
    }
  }

  static byte[] FromBase64Url(string value) {
    string padded = value.Replace('-', '+').Replace('_', '/');
    return Convert.FromBase64String(padded + new string('=', (4 - padded.Length % 4) % 4));
  }

  // Grants are by ACL, so a policy path must be the canonical NTFS object itself, never a link or a network path.
  static string Canonical(string path) {
    if (path == null || path.IndexOf('\0') >= 0 || !Path.IsPathRooted(path) || path.StartsWith(@"\\")) throw new ArgumentException("absolute local path required");
    if (Path.GetFullPath(path) != path) throw new ArgumentException("canonical path required");
    if (new DriveInfo(Path.GetPathRoot(path)).DriveFormat != "NTFS") throw new ArgumentException("NTFS volume required");
    for (string current = path; current != null && current != Path.GetPathRoot(current); current = Path.GetDirectoryName(current))
      if (File.Exists(current) || Directory.Exists(current))
        if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new ArgumentException("reparse point in policy path");
    return path;
  }

  static void Validate(Policy p) {
    if (p == null || p.args == null || p.env == null || p.readPaths == null || p.writePaths == null || p.denyPaths == null) throw new ArgumentException("incomplete policy");
    if (p.timeoutMs < 1 || p.timeoutMs > 3600000 || p.activeProcessLimit < 1 || p.activeProcessLimit > 64) throw new ArgumentException("invalid limits");
    Canonical(p.executable); Canonical(p.cwd); Canonical(p.reportPath); Canonical(p.journalPath);
    foreach (string path in p.readPaths) Canonical(path);
    foreach (string path in p.writePaths) Canonical(path);
    foreach (string path in p.denyPaths) Canonical(path);
    if (!p.journalPath.EndsWith(".journal")) throw new ArgumentException("journal must end in .journal");
    if (File.Exists(p.reportPath) || File.Exists(p.journalPath)) throw new ArgumentException("report or journal already exists");
    PrivateFolder(Path.GetDirectoryName(p.reportPath)); PrivateFolder(Path.GetDirectoryName(p.journalPath));
    foreach (string arg in p.args) if (arg == null || arg.IndexOf('\0') >= 0) throw new ArgumentException("invalid argument");
    foreach (KeyValuePair<string, string> pair in p.env)
      if (pair.Key.Length == 0 || pair.Key.IndexOf('=') >= 0 || pair.Key.IndexOf('\0') >= 0 || pair.Value == null || pair.Value.IndexOf('\0') >= 0) throw new ArgumentException("invalid environment");
  }

  // The report and journal live in the owner's state root. No AppContainer or capability may do more there than the
  // read-attributes that setup grants, or a contained child could plant a report or rewrite the journal.
  static void PrivateFolder(string folder) {
    foreach (FileSystemAccessRule rule in Directory.GetAccessControl(folder, AccessControlSections.Access).GetAccessRules(true, true, typeof(SecurityIdentifier))) {
      string value = rule.IdentityReference.Value;
      if (rule.AccessControlType == AccessControlType.Allow && (value.StartsWith("S-1-15-2-") || value.StartsWith("S-1-15-3-")) &&
          ((int)rule.FileSystemRights & ~0x1000A0) != 0) throw new ArgumentException("state root is reachable from AppContainers");
    }
  }

  static int Run(Policy p) {
    Validate(p);
    // Opened exclusively before the child exists, so nothing else can create, replace or delete the report.
    using (FileStream report = new FileStream(p.reportPath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
      return Run(p, report);
  }

  static int Run(Policy p, FileStream report) {
    string name = "forgemind." + RandomHex(16);
    IntPtr derived;
    int derivation = DeriveAppContainerSidFromAppContainerName(name, out derived);
    if (derivation != 0) throw new Win32Exception(derivation, "AppContainer SID");
    SecurityIdentifier sid = new SecurityIdentifier(derived);
    FreeSid(derived);
    // AppContainer access checks ignore deny ACEs for the package SID, so a denied path is protected by never
    // granting it: folders above a denied entry get a this-folder-only ACE and their other entries are granted one by one.
    List<string> readTrees = new List<string>(), objects = new List<string>();
    foreach (string path in p.readPaths) PlanRead(path, p.denyPaths, readTrees, objects);
    List<string> trees = new List<string>(readTrees);
    trees.AddRange(p.writePaths);
    // The journal is complete before the profile or any grant exists, so a killed launcher always leaves enough to undo
    // it. Sweep only reads *.journal, and the rename makes the finished file appear at once.
    string pending = p.journalPath + ".tmp";
    File.WriteAllText(pending, json.Serialize(new Journal { name = name, sid = sid.Value, trees = trees.ToArray(), objects = objects.ToArray() }));
    File.Move(pending, p.journalPath);
    // Held read-shared until cleanup, so the journal cannot be rewritten while the child runs.
    FileStream journalHold = new FileStream(p.journalPath, FileMode.Open, FileAccess.Read, FileShare.Read);
    IntPtr sidPointer;
    int created = CreateAppContainerProfile(name, name, "ForgeMind contained run", IntPtr.Zero, 0, out sidPointer);
    if (created != 0) throw new Win32Exception(created, "AppContainer profile");
    if (new SecurityIdentifier(sidPointer) != sid) { FreeSid(sidPointer); DeleteAppContainerProfile(name); throw new InvalidOperationException("AppContainer SID mismatch"); }
    string status = "error", message = "";
    uint exitCode = 0; bool exited = false;
    try {
      foreach (string path in readTrees) Grant(path, sid, FileSystemRights.ReadAndExecute);
      foreach (string path in objects) DirectAce(path, sid, ReadMask);
      foreach (string path in p.writePaths) Grant(path, sid, FileSystemRights.Modify | FileSystemRights.Synchronize);
      // user32 start-up needs the window station and desktop; service sessions (SSH) lack the package ACE there.
      // Enumerate/read/atoms on the station; read, write, windows and menus on the desktop; no hooks or journaling.
      WindowAccess(GetProcessWindowStation(), sid, 0x20123, true);
      WindowAccess(GetThreadDesktop(GetCurrentThreadId()), sid, 0x200C7, true);
      status = Launch(p, sidPointer, out exitCode, out exited);
    } catch (Exception error) {
      status = "error"; message = error.Message + (error is Win32Exception ? " (" + ((Win32Exception)error).NativeErrorCode + ")" : "");
    } finally {
      FreeSid(sidPointer);
    }
    bool clean = Revoke(sid, trees, objects) & DeleteAppContainerProfile(name) == 0;
    clean &= TryWindowAccess(GetProcessWindowStation(), sid) & TryWindowAccess(GetThreadDesktop(GetCurrentThreadId()), sid);
    journalHold.Dispose();
    if (clean) File.Delete(p.journalPath);
    else if (status == "reaped" || status == "deadline") status = "cleanup-uncertain";
    WriteReport(report, status, exited ? (object)exitCode : null, message, sid.Value);
    return status == "reaped" ? 0 : 3;
  }

  static string Launch(Policy p, IntPtr sid, out uint exitCode, out bool exited) {
    exitCode = 0; exited = false;
    IntPtr job = CreateJobObject(IntPtr.Zero, IntPtr.Zero);
    Check(job != IntPtr.Zero, "job");
    ExtendedLimit limit = new ExtendedLimit();
    // No breakaway flag is set, so no descendant can leave the job; closing our handle kills every member.
    limit.Basic.LimitFlags = KillOnJobClose | DieOnUnhandledException | ActiveProcess;
    limit.Basic.ActiveProcessLimit = (uint)p.activeProcessLimit;
    Check(SetInformationJobObject(job, 9, ref limit, Marshal.SizeOf(typeof(ExtendedLimit))), "job limits");
    uint ui = 0xFF;
    Check(SetInformationJobObject(job, 4, ref ui, 4), "job UI limits");

    List<IntPtr> handles = new List<IntPtr>();
    IntPtr[] std = { GetStdHandle(-10), GetStdHandle(-11), GetStdHandle(-12) };
    foreach (IntPtr handle in std)
      if (handle != IntPtr.Zero && handle != new IntPtr(-1) && !handles.Contains(handle)) {
        Check(SetHandleInformation(handle, 1, 1), "inherit stdio");
        handles.Add(handle);
      }
    IntPtr size = IntPtr.Zero;
    InitializeProcThreadAttributeList(IntPtr.Zero, 3, 0, ref size);
    IntPtr list = Marshal.AllocHGlobal(size), capabilities = IntPtr.Zero, capabilityList = IntPtr.Zero, runtime = IntPtr.Zero, childPolicy = IntPtr.Zero, handleList = IntPtr.Zero, environment = IntPtr.Zero;
    ProcessInformation info = new ProcessInformation();
    bool initialized = false;
    try {
      Check(InitializeProcThreadAttributeList(list, 3, 0, ref size), "attribute list");
      initialized = true;
      if (p.activeProcessLimit == 1) {
        // A single-process run cannot create children at all, so a spawn fails at once instead of tripping the job limit.
        childPolicy = Marshal.AllocHGlobal(4);
        Marshal.WriteInt32(childPolicy, 1);
        Check(UpdateProcThreadAttribute(list, 0, new IntPtr(0x0002000E), childPolicy, new IntPtr(4), IntPtr.Zero, IntPtr.Zero), "child process policy");
      }
      runtime = RuntimeCapability();
      SidAndAttributes[] grants = { new SidAndAttributes { Sid = runtime, Attributes = 4 } };
      capabilityList = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SidAndAttributes)));
      Marshal.StructureToPtr(grants[0], capabilityList, false);
      SecurityCapabilities caps = new SecurityCapabilities { AppContainerSid = sid, Capabilities = capabilityList, CapabilityCount = 1 };
      capabilities = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SecurityCapabilities)));
      Marshal.StructureToPtr(caps, capabilities, false);
      Check(UpdateProcThreadAttribute(list, 0, new IntPtr(0x00020009), capabilities, new IntPtr(Marshal.SizeOf(typeof(SecurityCapabilities))), IntPtr.Zero, IntPtr.Zero), "capabilities attribute");
      if (handles.Count > 0) {
        handleList = Marshal.AllocHGlobal(IntPtr.Size * handles.Count);
        Marshal.Copy(handles.ToArray(), 0, handleList, handles.Count);
        Check(UpdateProcThreadAttribute(list, 0, new IntPtr(0x00020002), handleList, new IntPtr(IntPtr.Size * handles.Count), IntPtr.Zero, IntPtr.Zero), "handle attribute");
      }
      StartupInfoEx startup = new StartupInfoEx();
      startup.StartupInfo.cb = Marshal.SizeOf(typeof(StartupInfoEx));
      startup.StartupInfo.dwFlags = 0x100;
      startup.StartupInfo.hStdInput = std[0]; startup.StartupInfo.hStdOutput = std[1]; startup.StartupInfo.hStdError = std[2];
      startup.lpAttributeList = list;
      environment = Marshal.StringToHGlobalUni(EnvironmentBlock(p.env));
      StringBuilder commandLine = new StringBuilder(CommandLine(p.executable, p.args));
      Check(CreateProcess(p.executable, commandLine, IntPtr.Zero, IntPtr.Zero, handles.Count > 0,
          ExtendedStartupInfoPresent | CreateSuspended | UnicodeEnvironment | DetachedProcess, environment, p.cwd, ref startup, out info), "create process");
      // The child runs no instruction until it is in the job.
      if (!AssignProcessToJobObject(job, info.hProcess)) { int error = Marshal.GetLastWin32Error(); TerminateProcess(info.hProcess, 1); throw new Win32Exception(error, "assign job"); }
      if (ResumeThread(info.hThread) == uint.MaxValue) { int error = Marshal.GetLastWin32Error(); TerminateJobObject(job, 1); throw new Win32Exception(error, "resume"); }
      DateTime deadline = DateTime.UtcNow.AddMilliseconds(p.timeoutMs);
      string status = "reaped";
      while (ActiveProcesses(job) > 0) {
        if (status == "reaped" && DateTime.UtcNow >= deadline) { status = "deadline"; TerminateJobObject(job, 1); }
        Thread.Sleep(20);
      }
      exited = GetExitCodeProcess(info.hProcess, out exitCode);
      return status;
    } finally {
      if (info.hProcess != IntPtr.Zero) CloseHandle(info.hProcess);
      if (info.hThread != IntPtr.Zero) CloseHandle(info.hThread);
      if (initialized) DeleteProcThreadAttributeList(list);
      Marshal.FreeHGlobal(list);
      if (capabilities != IntPtr.Zero) Marshal.FreeHGlobal(capabilities);
      if (capabilityList != IntPtr.Zero) Marshal.FreeHGlobal(capabilityList);
      if (childPolicy != IntPtr.Zero) Marshal.FreeHGlobal(childPolicy);
      if (runtime != IntPtr.Zero) LocalFree(runtime);
      if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
      if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
      CloseHandle(job);
    }
  }

  static void Check(bool ok, string stage) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), stage); }

  static uint ActiveProcesses(IntPtr job) {
    Accounting accounting;
    Check(QueryInformationJobObject(job, 1, out accounting, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero), "job accounting");
    return accounting.ActiveProcesses;
  }

  const int ReadMask = 0x1200A9;

  static bool Under(string path, string parent) {
    string prefix = parent.EndsWith("\\") ? parent : parent + "\\";
    return path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) && path.Length > prefix.Length;
  }
  static bool Denied(string path, string[] deny) {
    foreach (string entry in deny) if (string.Equals(entry, path, StringComparison.OrdinalIgnoreCase)) return true;
    return false;
  }
  static void PlanRead(string path, string[] deny, List<string> trees, List<string> objects) {
    if (Denied(path, deny)) return;
    bool above = false;
    foreach (string entry in deny) if (Under(entry, path)) above = true;
    if (!above) { trees.Add(path); return; }
    objects.Add(path);
    foreach (string entry in Directory.GetFileSystemEntries(path)) {
      FileAttributes attributes = File.GetAttributes(entry);
      if ((attributes & FileAttributes.ReparsePoint) != 0) continue; // never grant through a link
      if ((attributes & FileAttributes.Directory) != 0) PlanRead(entry, deny, trees, objects);
      else if (!Denied(entry, deny)) objects.Add(entry);
    }
  }

  // Inheritable grant; SetNamedSecurityInfo propagates it to the existing tree below.
  static void Grant(string path, SecurityIdentifier sid, FileSystemRights rights) {
    if (Directory.Exists(path)) {
      DirectorySecurity security = Directory.GetAccessControl(path, AccessControlSections.Access);
      security.AddAccessRule(new FileSystemAccessRule(sid, rights, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
      Directory.SetAccessControl(path, security);
    } else if (File.Exists(path)) {
      FileSecurity security = File.GetAccessControl(path, AccessControlSections.Access);
      security.AddAccessRule(new FileSystemAccessRule(sid, rights, AccessControlType.Allow));
      File.SetAccessControl(path, security);
    } else throw new FileNotFoundException("policy path missing");
  }

  // Adds (grant) or removes every ACE for sid on a window station or desktop handle (SE_WINDOW_OBJECT).
  static void WindowAccess(IntPtr handle, SecurityIdentifier sid, int mask, bool grant) {
    if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "window object");
    IntPtr dacl, pointer;
    int error = GetSecurityInfo(handle, 7, 4, IntPtr.Zero, IntPtr.Zero, out dacl, IntPtr.Zero, out pointer);
    if (error != 0) throw new Win32Exception(error, "read window security");
    byte[] bytes = new byte[GetSecurityDescriptorLength(pointer)];
    Marshal.Copy(pointer, bytes, 0, bytes.Length); LocalFree(pointer);
    RawAcl acl = new RawSecurityDescriptor(bytes, 0).DiscretionaryAcl;
    for (int i = acl.Count - 1; i >= 0; i--) {
      KnownAce ace = acl[i] as KnownAce;
      if (ace != null && ace.SecurityIdentifier == sid) acl.RemoveAce(i);
    }
    if (grant) acl.InsertAce(acl.Count, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, mask, sid, false, null));
    byte[] updated = new byte[acl.BinaryLength];
    acl.GetBinaryForm(updated, 0);
    error = SetSecurityInfo(handle, 7, 4, IntPtr.Zero, IntPtr.Zero, updated, IntPtr.Zero);
    if (error != 0) throw new Win32Exception(error, "write window security");
  }
  static bool TryWindowAccess(IntPtr handle, SecurityIdentifier sid) {
    try { WindowAccess(handle, sid, 0, false); return true; } catch (Exception) { return false; }
  }

  static bool Revoke(SecurityIdentifier sid, IEnumerable<string> trees, IEnumerable<string> objects) {
    bool clean = true;
    foreach (string path in objects) {
      try { if (File.Exists(path) || Directory.Exists(path)) EditDacl(path, delegate (RawAcl acl) { return RemoveAces(acl, sid); }); }
      catch (Exception) { clean = false; }
    }
    foreach (string path in trees) {
      try {
        if (Directory.Exists(path)) {
          DirectorySecurity security = Directory.GetAccessControl(path, AccessControlSections.Access);
          security.PurgeAccessRules(sid); Directory.SetAccessControl(path, security);
        } else if (File.Exists(path)) {
          FileSecurity security = File.GetAccessControl(path, AccessControlSections.Access);
          security.PurgeAccessRules(sid); File.SetAccessControl(path, security);
        }
      } catch (Exception) { clean = false; }
    }
    return clean;
  }

  // The one capability every contained run holds. Setup grants it read-attributes only, never file contents.
  static IntPtr RuntimeCapability() {
    IntPtr groups, sids; uint groupCount, count;
    Check(DeriveCapabilitySidsFromName("forgemindRuntime", out groups, out groupCount, out sids, out count), "capability");
    for (uint i = 0; i < groupCount; i++) LocalFree(Marshal.ReadIntPtr(groups, (int)(i * IntPtr.Size)));
    LocalFree(groups);
    if (count != 1) throw new InvalidOperationException("capability");
    IntPtr sid = Marshal.ReadIntPtr(sids); LocalFree(sids);
    return sid;
  }

  static int Setup(string[] argv) {
    IntPtr pointer = RuntimeCapability();
    SecurityIdentifier capability = new SecurityIdentifier(pointer);
    LocalFree(pointer);
    for (int i = 1; i < argv.Length; i++)
      for (string current = Canonical(argv[i]); current != null; current = Path.GetDirectoryName(current))
        DirectAce(current, capability, 0x1000A0); // read attributes, traverse, synchronize
    Console.Out.WriteLine(json.Serialize(new Dictionary<string, object> { { "capability", capability.Value } }));
    return 0;
  }

  // Adds an allow ACE to this object only. SetKernelObjectSecurity does not walk children, unlike
  // SetNamedSecurityInfo, which would rewrite every file under a volume root.
  static void DirectAce(string path, SecurityIdentifier sid, int mask) {
    EditDacl(path, delegate (RawAcl acl) {
      int position = acl.Count;
      for (int i = 0; i < acl.Count; i++) {
        CommonAce ace = acl[i] as CommonAce;
        if (ace != null && ace.SecurityIdentifier == sid && ace.AccessMask == mask && (ace.AceFlags & AceFlags.Inherited) == 0) return false;
        if ((acl[i].AceFlags & AceFlags.Inherited) != 0 && position == acl.Count) position = i;
      }
      // Explicit allows sit after explicit denies and before inherited ACEs, which keeps the ACL canonical.
      acl.InsertAce(position, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, mask, sid, false, null));
      return true;
    });
  }
  static bool RemoveAces(RawAcl acl, SecurityIdentifier sid) {
    bool changed = false;
    for (int i = acl.Count - 1; i >= 0; i--) {
      KnownAce ace = acl[i] as KnownAce;
      if (ace != null && ace.SecurityIdentifier == sid && (ace.AceFlags & AceFlags.Inherited) == 0) { acl.RemoveAce(i); changed = true; }
    }
    return changed;
  }
  static void EditDacl(string path, Func<RawAcl, bool> edit) {
    IntPtr handle = CreateFile(path, 0x60000, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    Check(handle != new IntPtr(-1), "open for security");
    try {
      int needed;
      GetKernelObjectSecurity(handle, 4, null, 0, out needed);
      byte[] bytes = new byte[needed];
      Check(GetKernelObjectSecurity(handle, 4, bytes, needed, out needed), "read security");
      RawSecurityDescriptor descriptor = new RawSecurityDescriptor(bytes, 0);
      if (!edit(descriptor.DiscretionaryAcl)) return;
      byte[] updated = new byte[descriptor.BinaryLength];
      descriptor.GetBinaryForm(updated, 0);
      Check(SetKernelObjectSecurity(handle, 4, updated), "write security");
    } finally { CloseHandle(handle); }
  }

  static int Sweep(string directory) {
    int failures = 0;
    foreach (string file in Directory.GetFiles(Canonical(directory), "*.journal")) {
      Journal journal;
      try { journal = json.Deserialize<Journal>(File.ReadAllText(file)); } catch (Exception) { journal = null; }
      if (journal == null || journal.name == null || journal.sid == null || !journal.name.StartsWith("forgemind.") || journal.trees == null || journal.objects == null) { failures++; continue; }
      bool clean = Revoke(new SecurityIdentifier(journal.sid), journal.trees, journal.objects);
      int deleted = DeleteAppContainerProfile(journal.name);
      if (clean && (deleted == 0 || deleted == unchecked((int)0x80070002))) File.Delete(file); else failures++;
    }
    Console.Out.WriteLine(json.Serialize(new Dictionary<string, object> { { "failures", failures } }));
    return failures == 0 ? 0 : 3;
  }

  static void WriteReport(FileStream report, string status, object exitCode, string message, string sid) {
    byte[] bytes = Encoding.UTF8.GetBytes(json.Serialize(new Dictionary<string, object> { { "status", status }, { "exitCode", exitCode }, { "message", message }, { "sid", sid } }));
    report.Write(bytes, 0, bytes.Length);
    report.Flush(true);
  }

  static string EnvironmentBlock(Dictionary<string, string> env) {
    List<string> keys = new List<string>(env.Keys);
    keys.Sort(StringComparer.OrdinalIgnoreCase);
    StringBuilder block = new StringBuilder();
    foreach (string key in keys) block.Append(key).Append('=').Append(env[key]).Append('\0');
    return block.Append('\0').ToString();
  }

  // Quote for CommandLineToArgvW, which is how Node and the C runtime split the command line.
  static string CommandLine(string executable, string[] args) {
    StringBuilder line = new StringBuilder(Quote(executable));
    foreach (string arg in args) line.Append(' ').Append(Quote(arg));
    return line.ToString();
  }
  static string Quote(string value) {
    if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return value;
    StringBuilder quoted = new StringBuilder("\"");
    int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      quoted.Append('\\', c == '"' ? slashes * 2 + 1 : slashes).Append(c);
      slashes = 0;
    }
    return quoted.Append('\\', slashes * 2).Append('"').ToString();
  }

  static string RandomHex(int bytes) {
    byte[] buffer = new byte[bytes];
    using (RandomNumberGenerator random = RandomNumberGenerator.Create()) random.GetBytes(buffer);
    return BitConverter.ToString(buffer).Replace("-", "").ToLowerInvariant();
  }
}
