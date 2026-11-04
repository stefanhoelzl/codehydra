// codehydra-procs.exe — CodeHydra's Windows process helper.
//
// A .NET Framework 4.8 exe (codehydra-procs.csproj), built at build time by
// scripts/build-win-helper.ts with the .NET SDK on any OS, and bundled as
// bin/codehydra-procs.exe. Every command prints one JSON object and exits:
//
//   codehydra-procs.exe listeners          listening TCP sockets {"listeners":[{pid,port}]}
//   codehydra-procs.exe detect <dir>       processes blocking removal of <dir>: Restart
//                                          Manager file handles + CWD {"blocking":[...]}
//   codehydra-procs.exe detect-cwd <dir>   CWD only. Runs BEFORE a removal is attempted,
//                                          so it is on the critical path and does less work.
//
// An error prints {"error":"message"} and exits 1; a usage error exits 2.
//
// The detection itself is BlockingProcessDetector.cs (moved here from the
// PowerShell script that used to compile it with Add-Type on every run).

using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class Program {
    public static int Main(string[] args) {
        Console.OutputEncoding = new UTF8Encoding(false);
        try {
            string command = args.Length > 0 ? args[0] : "";
            switch (command) {
                case "listeners":
                    Console.Out.Write(Listeners());
                    return 0;
                case "detect":
                case "detect-cwd":
                    if (args.Length < 2) return Usage();
                    Console.Out.Write(Detect(args[1], command == "detect-cwd"));
                    return 0;
                default:
                    return Usage();
            }
        } catch (Exception e) {
            var json = new Json();
            json.Raw("{\"error\":").String(e.Message).Raw("}");
            Console.Out.Write(json.ToString());
            return 1;
        }
    }

    private static int Usage() {
        Console.Error.WriteLine("usage: codehydra-procs.exe listeners | detect <dir> | detect-cwd <dir>");
        return 2;
    }

    // =========================================================================
    // listeners
    // =========================================================================

    private const int AF_INET = 2;
    private const int AF_INET6 = 23;
    private const int TCP_TABLE_OWNER_PID_LISTENER = 3;

    [DllImport("iphlpapi.dll", SetLastError = true)]
    private static extern uint GetExtendedTcpTable(
        IntPtr tcpTable, ref int size, bool sort, int ipVersion, int tableClass, uint reserved);

    private static string Listeners() {
        var json = new Json();
        json.Raw("{\"listeners\":[");
        bool first = true;
        // MIB_TCPROW_OWNER_PID: 24 bytes, local port at 8, pid at 20.
        // MIB_TCP6ROW_OWNER_PID: 56 bytes, local port at 20, pid at 52.
        foreach (var family in new[] { new[] { AF_INET, 24, 8, 20 }, new[] { AF_INET6, 56, 20, 52 } }) {
            foreach (var row in ReadTcpTable(family[0], family[1], family[2], family[3])) {
                if (!first) json.Raw(",");
                first = false;
                json.Raw("{\"pid\":").Number(row[0]).Raw(",\"port\":").Number(row[1]).Raw("}");
            }
        }
        json.Raw("]}");
        return json.ToString();
    }

    /** [pid, port] for each listening row of one address family. */
    private static List<int[]> ReadTcpTable(int family, int rowSize, int portOffset, int pidOffset) {
        var rows = new List<int[]>();
        int size = 0;
        GetExtendedTcpTable(IntPtr.Zero, ref size, false, family, TCP_TABLE_OWNER_PID_LISTENER, 0);
        if (size <= 0) return rows;
        // The table can grow between the size query and the read; retry a few times.
        for (int attempt = 0; attempt < 3; attempt++) {
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try {
                uint result = GetExtendedTcpTable(buffer, ref size, false, family, TCP_TABLE_OWNER_PID_LISTENER, 0);
                if (result == 122) continue; // ERROR_INSUFFICIENT_BUFFER: size was updated
                if (result != 0) return rows;
                int count = Marshal.ReadInt32(buffer);
                for (int i = 0; i < count; i++) {
                    IntPtr row = IntPtr.Add(buffer, 4 + i * rowSize);
                    int rawPort = Marshal.ReadInt32(row, portOffset);
                    int port = ((rawPort & 0xFF) << 8) | ((rawPort >> 8) & 0xFF); // network byte order
                    int pid = Marshal.ReadInt32(row, pidOffset);
                    if (pid > 0 && port > 0) rows.Add(new[] { pid, port });
                }
                return rows;
            } finally {
                Marshal.FreeHGlobal(buffer);
            }
        }
        return rows;
    }

    // =========================================================================
    // detect / detect-cwd
    // =========================================================================

    /** A process's CWD relative to the workspace ("." for its root), or null when outside it. */
    private static string RelativeCwd(int pid, string workspacePath) {
        string cwd = BlockingProcessDetector.GetProcessCwd(pid);
        if (cwd == null) return null;
        string normalizedCwd = Path.GetFullPath(cwd).TrimEnd('\\', '/');
        string normalizedBase = workspacePath.TrimEnd('\\', '/');
        if (!normalizedCwd.StartsWith(normalizedBase, StringComparison.OrdinalIgnoreCase)) return null;
        if (normalizedCwd.Length == normalizedBase.Length) return ".";
        char next = normalizedCwd[normalizedBase.Length];
        if (next == '\\' || next == '/') return normalizedCwd.Substring(normalizedBase.Length + 1);
        return null;
    }

    private static string Detect(string basePath, bool cwdOnly) {
        string workspacePath = Path.GetFullPath(basePath);
        List<BlockingProcessDetector.ProcessInfo> processes;
        List<BlockingProcessDetector.HandleInfo> handles = new List<BlockingProcessDetector.HandleInfo>();

        if (cwdOnly) {
            processes = BlockingProcessDetector.GetProcessesWithCwdUnder(workspacePath);
        } else {
            // Step 1: Restart Manager, then the CWD scan (always, not just when
            // the directory is empty and Restart Manager has nothing to go on).
            processes = BlockingProcessDetector.GetBlockingProcesses(workspacePath);
            var seen = new HashSet<int>();
            foreach (var proc in processes) seen.Add(proc.Pid);
            foreach (var proc in BlockingProcessDetector.GetProcessesWithCwdUnder(workspacePath)) {
                if (seen.Add(proc.Pid)) processes.Add(proc);
            }
            // Step 2: the file handles those processes hold inside the workspace.
            if (processes.Count > 0) {
                handles = BlockingProcessDetector.GetFileHandles(workspacePath, seen);
            }
        }

        var json = new Json();
        json.Raw("{\"blocking\":[");
        bool first = true;
        foreach (var proc in processes) {
            string commandLine = BlockingProcessDetector.GetProcessCommandLine(proc.Pid);
            if (string.IsNullOrEmpty(commandLine)) commandLine = proc.Name;

            // At most 20 files per process, relative to the workspace, each once.
            var files = new List<string>();
            foreach (var handle in handles) {
                if (handle.ProcessId != proc.Pid || files.Count >= 20) continue;
                string relative = handle.DosPath.Substring(workspacePath.Length).TrimStart('\\', '/');
                if (relative.Length > 0 && !files.Contains(relative)) files.Add(relative);
            }

            if (!first) json.Raw(",");
            first = false;
            json.Raw("{\"pid\":").Number(proc.Pid)
                .Raw(",\"name\":").String(proc.Name)
                .Raw(",\"commandLine\":").String(commandLine)
                .Raw(",\"files\":[");
            for (int i = 0; i < files.Count; i++) {
                if (i > 0) json.Raw(",");
                json.String(files[i]);
            }
            json.Raw("],\"cwd\":").String(RelativeCwd(proc.Pid, workspacePath)).Raw("}");
        }
        json.Raw("]}");
        return json.ToString();
    }

    // =========================================================================
    // JSON
    // =========================================================================

    /** Just enough JSON writing: .NET Framework has no serializer in the base library. */
    private sealed class Json {
        private readonly StringBuilder builder = new StringBuilder();

        public Json Raw(string text) {
            builder.Append(text);
            return this;
        }

        public Json Number(double? value) {
            if (value == null || double.IsNaN(value.Value) || double.IsInfinity(value.Value)) {
                builder.Append("null");
            } else {
                builder.Append(value.Value.ToString("R", System.Globalization.CultureInfo.InvariantCulture));
            }
            return this;
        }

        public Json String(string value) {
            if (value == null) {
                builder.Append("null");
                return this;
            }
            builder.Append('"');
            foreach (char c in value) {
                switch (c) {
                    case '"': builder.Append("\\\""); break;
                    case '\\': builder.Append("\\\\"); break;
                    case '\n': builder.Append("\\n"); break;
                    case '\r': builder.Append("\\r"); break;
                    case '\t': builder.Append("\\t"); break;
                    default:
                        if (c < 0x20) builder.Append("\\u").Append(((int)c).ToString("x4"));
                        else builder.Append(c);
                        break;
                }
            }
            builder.Append('"');
            return this;
        }

        public override string ToString() {
            return builder.ToString();
        }
    }
}
