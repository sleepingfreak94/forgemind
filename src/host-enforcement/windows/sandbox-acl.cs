// ACL helpers for the ForgeMind Windows sandbox launcher (sandbox-launcher.cs, ADR-0017).
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;

static partial class Launcher {
  // The report and journal live in the owner's state root. No AppContainer or capability may do more there than the
  // read-attributes that setup grants, or a contained child could plant a report or rewrite the journal.
  static void PrivateFolder(string folder) {
    // A NULL DACL grants everyone, AppContainers included, full access. .NET shows it as an Everyone rule, so read the raw descriptor.
    if (new RawSecurityDescriptor(Security(folder, 4), 0).DiscretionaryAcl == null) throw new ArgumentException("state root is reachable from AppContainers");
    foreach (FileSystemAccessRule rule in Directory.GetAccessControl(folder, AccessControlSections.Access).GetAccessRules(true, true, typeof(SecurityIdentifier))) {
      string value = rule.IdentityReference.Value;
      if (rule.AccessControlType == AccessControlType.Allow && (value.StartsWith("S-1-15-2-") || value.StartsWith("S-1-15-3-")) &&
          ((int)rule.FileSystemRights & ~0x1000A0) != 0) throw new ArgumentException("state root is reachable from AppContainers");
    }
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

  // POSIX checks (owner uid, no group or world bits) translated to Windows. Besides the user, only SYSTEM and Administrators
  // may hold access; anyone may read attributes and traverse, which is what setup grants the runtime capability.
  // private: owner state such as ledgers and policy databases. trusted: an executable nobody else can change.
  static readonly string[] Owners = { "S-1-5-18", "S-1-5-32-544" };
  const string CreatorOwner = "S-1-3-0";
  const string TrustedInstaller = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
  // Write data, append, write EA, delete child, write attributes, delete, WRITE_DAC, WRITE_OWNER, GENERIC_ALL, GENERIC_WRITE.
  const int WriteMask = 0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000;

  static int Acl(string[] argv) {
    string user = WindowsIdentity.GetCurrent().User.Value;
    if (argv.Length == 2 && argv[1] == "user") { Print(new Dictionary<string, object> { { "user", user } }); return 0; }
    if (argv.Length != 3 || (argv[1] != "private" && argv[1] != "trusted")) throw new ArgumentException("usage: acl user | acl private|trusted <path>");
    string reason = AclProblem(Canonical(argv[2]), user, argv[1] == "private");
    Print(new Dictionary<string, object> { { "user", user }, { "ok", reason == null }, { "reason", reason } });
    return 0; // the verdict is "ok"; a non-zero exit means the check itself failed
  }

  static string AclProblem(string path, string user, bool exclusive) {
    RawSecurityDescriptor descriptor = new RawSecurityDescriptor(Security(path, 1 | 4), 0);
    string owner = descriptor.Owner.Value;
    if (owner != user && Array.IndexOf(Owners, owner) < 0 && (exclusive || owner != TrustedInstaller)) return "owned by " + owner;
    if (descriptor.DiscretionaryAcl == null) return "no DACL";
    foreach (GenericAce ace in descriptor.DiscretionaryAcl) {
      // An inherit-only ACE applies to children only. Private state must not hand future children (such as a SQLite
      // journal) to anyone else, because every user may traverse folders by default; trusted children are checked themselves.
      if ((ace.AceFlags & AceFlags.InheritOnly) != 0 && !exclusive) continue;
      CommonAce common = ace as CommonAce;
      if (common == null) return "unsupported ACE";
      if (common.AceQualifier != AceQualifier.AccessAllowed) continue; // deny ACEs only take access away
      string sid = common.SecurityIdentifier.Value;
      if (sid == user || sid == CreatorOwner || Array.IndexOf(Owners, sid) >= 0 || (common.AccessMask & ~0x1000A0) == 0) continue;
      if (!exclusive && (sid == TrustedInstaller || (common.AccessMask & WriteMask) == 0)) continue;
      return "access for " + sid;
    }
    return null;
  }

  static byte[] Security(string path, int info) {
    IntPtr handle = CreateFile(path, 0x20000, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    Check(handle != new IntPtr(-1), "open for security");
    try {
      int needed;
      GetKernelObjectSecurity(handle, info, null, 0, out needed);
      byte[] bytes = new byte[needed];
      Check(GetKernelObjectSecurity(handle, info, bytes, needed, out needed), "read security");
      return bytes;
    } finally { CloseHandle(handle); }
  }

  static void Print(Dictionary<string, object> value) { Console.Out.WriteLine(json.Serialize(value)); }
}
