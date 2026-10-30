// Loopback lock for the ForgeMind Windows sandbox launcher (ADR-0017 phase 2b). The provider containers are
// loopback-exempt so they can reach the host's allow-list proxy, but the exemption covers every 127.0.0.1 listener and
// Windows Firewall rules do not filter loopback. Persistent WFP filters do: for each fixed container they block every
// loopback connection (any of the host's own addresses, which WFP flags as loopback) outside ForgeMind's own port range
// (proxy and MCP endpoints). Installing them needs admin.
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

static partial class Launcher {
  [StructLayout(LayoutKind.Explicit, Size = 72)] struct WfpSession { [FieldOffset(32)] public uint flags; }
  [StructLayout(LayoutKind.Explicit, Size = 72)] struct WfpSubLayer {
    [FieldOffset(0)] public Guid key; [FieldOffset(16)] public IntPtr name; [FieldOffset(32)] public uint flags; [FieldOffset(64)] public ushort weight; }
  [StructLayout(LayoutKind.Explicit, Size = 40)] struct WfpCondition {
    [FieldOffset(0)] public Guid field; [FieldOffset(16)] public int match; [FieldOffset(24)] public int type; [FieldOffset(32)] public ulong value; }
  [StructLayout(LayoutKind.Explicit, Size = 200)] struct WfpFilter {
    [FieldOffset(0)] public Guid key; [FieldOffset(16)] public IntPtr name; [FieldOffset(32)] public uint flags; [FieldOffset(64)] public Guid layer;
    [FieldOffset(80)] public Guid subLayer; [FieldOffset(96)] public int weightType; [FieldOffset(104)] public ulong weight;
    [FieldOffset(112)] public uint count; [FieldOffset(120)] public IntPtr conditions; [FieldOffset(128)] public uint action; }
  [DllImport("fwpuclnt.dll")] static extern uint FwpmEngineOpen0(string server, uint authn, IntPtr identity, ref WfpSession session, out IntPtr engine);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmEngineClose0(IntPtr engine);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmTransactionBegin0(IntPtr engine, uint flags);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmTransactionCommit0(IntPtr engine);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmTransactionAbort0(IntPtr engine);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmSubLayerAdd0(IntPtr engine, ref WfpSubLayer subLayer, IntPtr sd);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmSubLayerDeleteByKey0(IntPtr engine, ref Guid key);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmFilterAdd0(IntPtr engine, ref WfpFilter filter, IntPtr sd, out ulong id);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmFilterDeleteByKey0(IntPtr engine, ref Guid key);

  static readonly Guid ConnectV4 = new Guid("c38d57d1-05a7-4c33-904f-7fbceee60e82"), ConnectV6 = new Guid("4a72393b-319f-44bc-84c3-ba54dcb3b6b4");
  static readonly Guid PackageIdField = new Guid("71bc78fa-f17c-4997-a602-6abb261f351c"), RemotePortField = new Guid("c35a604d-d22b-4e1a-91b4-68f674ee674b");
  static readonly Guid FlagsField = new Guid("632ce23b-5167-435c-86d7-e903684aa80c");
  static readonly Guid LoopbackSubLayer = new Guid("6b0d4f9e-0c1f-4d3a-9a51-6f726765d1a1");
  const int MatchEqual = 0, MatchGreater = 1, MatchLess = 2, MatchFlagsAllSet = 6, TypeUint8 = 1, TypeUint16 = 2, TypeUint32 = 3, TypeSid = 13;
  const uint ActionBlock = 0x1001, Persistent = 1, NotFound = 0x80320003, SubLayerNotFound = 0x80320007, IsLoopback = 0x1;

  // Filter keys are derived from the container name, so a re-run of setup replaces its own filters and nothing else.
  static Guid FilterKey(string container, string family) {
    using (var md5 = MD5.Create()) return new Guid(md5.ComputeHash(Encoding.UTF8.GetBytes("forgemind.loopback." + container + "." + family)));
  }

  static int Loopback(string[] argv) {
    ushort first, last;
    if (argv.Length != 3 || !ushort.TryParse(argv[1], out first) || !ushort.TryParse(argv[2], out last) || first < 1024 || last < first || last - first > 63)
      throw new ArgumentException("loopback <first port> <last port>: at most 64 ports above 1023");
    if (IntPtr.Size != 8) throw new PlatformNotSupportedException("64-bit launcher required");
    var session = new WfpSession();
    IntPtr engine;
    Wfp(FwpmEngineOpen0(null, 10, IntPtr.Zero, ref session, out engine), "open filtering engine (run setup elevated)");
    var memory = new System.Collections.Generic.List<IntPtr>();
    Func<int, IntPtr> alloc = size => { IntPtr block = Marshal.AllocHGlobal(size); memory.Add(block); return block; };
    try {
      Wfp(FwpmTransactionBegin0(engine, 0), "begin");
      try {
        string[] containers = { "forgemind.claude", "forgemind.cursor" };
        foreach (string container in containers) foreach (string family in new[] { "v4", "v6" }) {
          Guid key = FilterKey(container, family);
          uint deleted = FwpmFilterDeleteByKey0(engine, ref key);
          if (deleted != 0 && deleted != NotFound) Wfp(deleted, "remove old filter");
        }
        Guid subLayerKey = LoopbackSubLayer;
        uint removed = FwpmSubLayerDeleteByKey0(engine, ref subLayerKey);
        if (removed != 0 && removed != SubLayerNotFound) Wfp(removed, "remove old sublayer");
        var subLayer = new WfpSubLayer { key = LoopbackSubLayer, name = Marshal.StringToHGlobalUni("ForgeMind sandbox loopback lock"), flags = Persistent, weight = 0x8000 };
        memory.Add(subLayer.name);
        Wfp(FwpmSubLayerAdd0(engine, ref subLayer, IntPtr.Zero), "add sublayer");
        foreach (string container in containers) {
          IntPtr sid;
          int derived = DeriveAppContainerSidFromAppContainerName(container, out sid);
          if (derived != 0) throw new Win32Exception(derived, "AppContainer SID");
          try {
            foreach (var family in new[] { Tuple.Create("v4", ConnectV4), Tuple.Create("v6", ConnectV6) }) {
              // Conditions on the same field are ORed, different fields ANDed: this container, loopback, outside [first, last].
              var conditions = new[] {
                new WfpCondition { field = PackageIdField, match = MatchEqual, type = TypeSid, value = (ulong)sid.ToInt64() },
                new WfpCondition { field = FlagsField, match = MatchFlagsAllSet, type = TypeUint32, value = IsLoopback },
                new WfpCondition { field = RemotePortField, match = MatchLess, type = TypeUint16, value = first },
                new WfpCondition { field = RemotePortField, match = MatchGreater, type = TypeUint16, value = last } };
              int size = Marshal.SizeOf(typeof(WfpCondition));
              IntPtr block = alloc(size * conditions.Length);
              for (int i = 0; i < conditions.Length; i++) Marshal.StructureToPtr(conditions[i], block + i * size, false);
              var filter = new WfpFilter { key = FilterKey(container, family.Item1), name = Marshal.StringToHGlobalUni("ForgeMind " + container + " loopback lock"),
                flags = Persistent, layer = family.Item2, subLayer = LoopbackSubLayer, weightType = TypeUint8, weight = 15,
                count = (uint)conditions.Length, conditions = block, action = ActionBlock };
              memory.Add(filter.name);
              ulong id;
              Wfp(FwpmFilterAdd0(engine, ref filter, IntPtr.Zero, out id), "add filter");
            }
          } finally { FreeSid(sid); }
        }
        Wfp(FwpmTransactionCommit0(engine), "commit");
      } catch { FwpmTransactionAbort0(engine); throw; }
    } finally {
      FwpmEngineClose0(engine);
      foreach (IntPtr block in memory) Marshal.FreeHGlobal(block);
    }
    Print(new System.Collections.Generic.Dictionary<string, object> { { "first", (int)first }, { "last", (int)last } });
    return 0;
  }

  static void Wfp(uint code, string what) { if (code != 0) throw new Win32Exception(unchecked((int)code), what + " failed (0x" + code.ToString("x8") + ")"); }
}
