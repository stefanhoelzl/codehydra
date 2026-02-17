# Unified script for detecting blocking processes and closing handles
# Usage:
#   blocking-processes.ps1 -BasePath "C:\path\to\dir" -Action Detect
#   blocking-processes.ps1 -BasePath "C:\path\to\dir" -Action CloseHandles
#
# Output: JSON object with structure:
#   -Action Detect: {"blocking": [...]}
#   -Action CloseHandles: {"blocking": [...], "closed": [...]}
#   Error: {"error": "message"}

param(
    [Parameter(Mandatory=$true)]
    [string]$BasePath,
    
    [Parameter(Mandatory=$true)]
    [ValidateSet('Detect', 'DetectCwd', 'CloseHandles')]
    [string]$Action
)

$ErrorActionPreference = 'Stop'

# Helper function to output JSON error
function Write-JsonError {
    param([string]$Message)
    @{ error = $Message } | ConvertTo-Json -Compress
}

# Note: ValidateSet already ensures exactly one valid mode is specified

# For CloseHandles mode, check if we need elevation
if ($Action -eq 'CloseHandles') {
    # Use the enum instead of string 'Administrator' for reliability
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    
    if (-not $isAdmin) {
        # Create temp file for output from elevated process
        # Note: Cannot use -RedirectStandardOutput with -Verb RunAs, so the elevated
        # script writes to a temp file that we pass as a parameter
        $outputFile = [System.IO.Path]::GetTempFileName()
        
        try {
            # Escape paths for command line
            $escapedScript = $MyInvocation.MyCommand.Path -replace "'", "''"
            $escapedBasePath = $BasePath -replace "'", "''"
            $escapedOutputFile = $outputFile -replace "'", "''"
            
            # Wrap in a command that redirects output to file
            $wrappedCommand = "& '$escapedScript' -BasePath '$escapedBasePath' -Action CloseHandles | Out-File -FilePath '$escapedOutputFile' -Encoding UTF8"
            
            $process = Start-Process powershell -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList @(
                '-NoProfile',
                '-NonInteractive',
                '-ExecutionPolicy', 'Bypass',
                '-Command', $wrappedCommand
            )
            
            # Read output from elevated process
            if (Test-Path $outputFile) {
                Get-Content $outputFile -Raw
                Remove-Item $outputFile -Force -ErrorAction SilentlyContinue
            }
            exit $process.ExitCode
        } catch {
            Remove-Item $outputFile -Force -ErrorAction SilentlyContinue
            if ($_.Exception.Message -match 'canceled by the user') {
                Write-JsonError "UAC cancelled by user"
                exit 1
            }
            Write-JsonError $_.Exception.Message
            exit 1
        }
    }
}

try {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
using System.Threading;

public class BlockingProcessDetector {
    // =============================================================================
    // Restart Manager API (for detecting blocking processes)
    // =============================================================================

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    public static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);

    [DllImport("rstrtmgr.dll")]
    public static extern int RmEndSession(uint pSessionHandle);

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    public static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames,
        uint nApplications, uint[] rgApplications, uint nServices, string[] rgsServiceNames);

    [DllImport("rstrtmgr.dll")]
    public static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo,
        [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct RM_PROCESS_INFO {
        public RM_UNIQUE_PROCESS Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
        public string strAppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]
        public string strServiceShortName;
        public uint ApplicationType;
        public uint AppStatus;
        public uint TSSessionId;
        [MarshalAs(UnmanagedType.Bool)]
        public bool bRestartable;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RM_UNIQUE_PROCESS {
        public uint dwProcessId;
        public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
    }

    // =============================================================================
    // NT API (for handle enumeration and CWD detection)
    // =============================================================================

    [DllImport("ntdll.dll")]
    public static extern int NtQuerySystemInformation(int SystemInformationClass, IntPtr SystemInformation, int SystemInformationLength, out int ReturnLength);

    [DllImport("ntdll.dll")]
    public static extern int NtQueryObject(IntPtr Handle, int ObjectInformationClass, IntPtr ObjectInformation, int ObjectInformationLength, out int ReturnLength);

    [DllImport("ntdll.dll")]
    public static extern int NtQueryInformationProcess(IntPtr ProcessHandle, int ProcessInformationClass, IntPtr ProcessInformation, int ProcessInformationLength, out int ReturnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(int dwDesiredAccess, bool bInheritHandle, int dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool DuplicateHandle(IntPtr hSourceProcessHandle, IntPtr hSourceHandle, IntPtr hTargetProcessHandle, out IntPtr lpTargetHandle, uint dwDesiredAccess, bool bInheritHandle, uint dwOptions);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll")]
    public static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool ReadProcessMemory(IntPtr hProcess, IntPtr lpBaseAddress, [Out] byte[] lpBuffer, int dwSize, out int lpNumberOfBytesRead);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWow64Process(IntPtr hProcess, out bool Wow64Process);

    [DllImport("ntdll.dll")]
    public static extern int NtQueryInformationProcess(IntPtr ProcessHandle, int ProcessInformationClass, IntPtr ProcessInformation, int ProcessInformationLength, IntPtr ReturnLength);

    // SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX structure (for SystemHandleInformationEx = 64)
    // This supports PIDs > 65535 (uses pointer-sized UniqueProcessId)
    [StructLayout(LayoutKind.Sequential)]
    public struct SYSTEM_HANDLE_ENTRY_EX {
        public IntPtr Object;              // PVOID Object
        public IntPtr UniqueProcessId;     // ULONG_PTR UniqueProcessId (pointer-sized!)
        public IntPtr HandleValue;         // ULONG_PTR HandleValue
        public uint GrantedAccess;         // ULONG GrantedAccess
        public ushort CreatorBackTraceIndex;
        public ushort ObjectTypeIndex;
        public uint HandleAttributes;
        public uint Reserved;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_BASIC_INFORMATION {
        public IntPtr Reserved1;
        public IntPtr PebBaseAddress;
        public IntPtr Reserved2_0;
        public IntPtr Reserved2_1;
        public IntPtr UniqueProcessId;
        public IntPtr Reserved3;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct UNICODE_STRING {
        public ushort Length;
        public ushort MaximumLength;
        public IntPtr Buffer;
    }

    private const int SystemHandleInformationEx = 64;  // Use extended version for PIDs > 65535
    private const int ObjectNameInformation = 1;
    private const int ProcessBasicInformation = 0;
    private const int PROCESS_QUERY_INFORMATION = 0x0400;
    private const int PROCESS_VM_READ = 0x0010;
    private const int PROCESS_DUP_HANDLE = 0x0040;
    private const int DUPLICATE_CLOSE_SOURCE = 0x1;
    private const int STATUS_INFO_LENGTH_MISMATCH = unchecked((int)0xC0000004);

    // =============================================================================
    // Path Utilities
    // =============================================================================

    private static string NormalizePath(string path) {
        try {
            return Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        } catch {
            return path;
        }
    }

    private static bool IsPathUnder(string path, string basePath) {
        string normalizedPath = NormalizePath(path);
        string normalizedBase = NormalizePath(basePath);
        return normalizedPath.StartsWith(normalizedBase, StringComparison.OrdinalIgnoreCase) &&
               (normalizedPath.Length == normalizedBase.Length ||
                normalizedPath[normalizedBase.Length] == Path.DirectorySeparatorChar ||
                normalizedPath[normalizedBase.Length] == Path.AltDirectorySeparatorChar);
    }

    private static string GetRelativePath(string fullPath, string basePath) {
        string normalizedPath = NormalizePath(fullPath);
        string normalizedBase = NormalizePath(basePath);
        if (normalizedPath.StartsWith(normalizedBase, StringComparison.OrdinalIgnoreCase)) {
            string relative = normalizedPath.Substring(normalizedBase.Length).TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            return string.IsNullOrEmpty(relative) ? null : relative;
        }
        return null;
    }

    // Query object name with timeout to avoid hanging on problematic handles (pipes, etc.)
    private static string GetObjectNameWithTimeout(IntPtr handle, int timeoutMs) {
        string result = null;
        var thread = new Thread(() => { result = GetObjectNameInternal(handle); });
        thread.Start();
        if (!thread.Join(timeoutMs)) {
            // Thread is stuck - abandon it (will be cleaned up by OS on process exit)
            return null;
        }
        return result;
    }

    private static string GetObjectNameInternal(IntPtr handle) {
        int bufferSize = 0x1000;
        IntPtr buffer = Marshal.AllocHGlobal(bufferSize);
        try {
            int returnLength;
            int status = NtQueryObject(handle, ObjectNameInformation, buffer, bufferSize, out returnLength);
            if (status != 0) return null;

            int nameLength = Marshal.ReadInt16(buffer);
            if (nameLength == 0) return null;

            IntPtr namePtr = Marshal.ReadIntPtr(IntPtr.Add(buffer, IntPtr.Size));
            return Marshal.PtrToStringUni(namePtr, nameLength / 2);
        } finally {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static Dictionary<string, string> _driveMap;
    private static string ConvertToDosPath(string ntPath) {
        if (_driveMap == null) {
            _driveMap = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var drive in DriveInfo.GetDrives()) {
                var sb = new StringBuilder(260);
                if (QueryDosDevice(drive.Name.TrimEnd('\\'), sb, 260) > 0) {
                    _driveMap[sb.ToString()] = drive.Name.TrimEnd('\\');
                }
            }
        }

        foreach (var kv in _driveMap) {
            if (ntPath.StartsWith(kv.Key, StringComparison.OrdinalIgnoreCase)) {
                return kv.Value + ntPath.Substring(kv.Key.Length);
            }
        }
        return null;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern int QueryDosDevice(string lpDeviceName, StringBuilder lpTargetPath, int ucchMax);

    // =============================================================================
    // CWD Detection
    // =============================================================================

    private const int ProcessWow64Information = 26;

    public static string GetProcessCwd(int pid) {
        IntPtr hProcess = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid);
        if (hProcess == IntPtr.Zero) return null;

        try {
            // Check if target is a WoW64 (32-bit) process
            bool isWow64 = false;
            IsWow64Process(hProcess, out isWow64);

            if (isWow64) {
                return GetProcessCwd32(hProcess);
            } else {
                return GetProcessCwd64(hProcess);
            }
        } catch {
            return null;
        } finally {
            CloseHandle(hProcess);
        }
    }

    private static string GetProcessCwd64(IntPtr hProcess) {
        // Get PEB address for 64-bit process
        var pbi = new PROCESS_BASIC_INFORMATION();
        int size = Marshal.SizeOf(pbi);
        IntPtr pbiPtr = Marshal.AllocHGlobal(size);
        try {
            int returnLength;
            int status = NtQueryInformationProcess(hProcess, ProcessBasicInformation, pbiPtr, size, out returnLength);
            if (status != 0) return null;

            pbi = (PROCESS_BASIC_INFORMATION)Marshal.PtrToStructure(pbiPtr, typeof(PROCESS_BASIC_INFORMATION));
        } finally {
            Marshal.FreeHGlobal(pbiPtr);
        }

        if (pbi.PebBaseAddress == IntPtr.Zero) return null;

        // Read ProcessParameters pointer from PEB (offset 0x20 on x64)
        byte[] buffer = new byte[8];
        int bytesRead;
        IntPtr processParametersOffset = IntPtr.Add(pbi.PebBaseAddress, 0x20);
        if (!ReadProcessMemory(hProcess, processParametersOffset, buffer, 8, out bytesRead) || bytesRead != 8)
            return null;

        IntPtr processParameters = (IntPtr)BitConverter.ToInt64(buffer, 0);
        if (processParameters == IntPtr.Zero) return null;

        // Read CurrentDirectory.DosPath UNICODE_STRING from ProcessParameters (offset 0x38 on x64)
        byte[] unicodeStringBuffer = new byte[16]; // UNICODE_STRING is 16 bytes on x64
        IntPtr currentDirOffset = IntPtr.Add(processParameters, 0x38);
        if (!ReadProcessMemory(hProcess, currentDirOffset, unicodeStringBuffer, 16, out bytesRead) || bytesRead != 16)
            return null;

        ushort length = BitConverter.ToUInt16(unicodeStringBuffer, 0);
        IntPtr cwdBuffer = (IntPtr)BitConverter.ToInt64(unicodeStringBuffer, 8);
        if (cwdBuffer == IntPtr.Zero || length == 0) return null;

        // Read the actual CWD string
        byte[] cwdBytes = new byte[length];
        if (!ReadProcessMemory(hProcess, cwdBuffer, cwdBytes, length, out bytesRead) || bytesRead != length)
            return null;

        string cwd = Encoding.Unicode.GetString(cwdBytes);
        // Remove trailing backslash if present
        return cwd.TrimEnd('\\');
    }

    private static string GetProcessCwd32(IntPtr hProcess) {
        // For WoW64 processes, we need to get the 32-bit PEB address
        // Use NtQueryInformationProcess with ProcessWow64Information
        IntPtr pebPtr = Marshal.AllocHGlobal(IntPtr.Size);
        try {
            int status = NtQueryInformationProcess(hProcess, ProcessWow64Information, pebPtr, IntPtr.Size, IntPtr.Zero);
            if (status != 0) return null;

            IntPtr peb32Address = Marshal.ReadIntPtr(pebPtr);
            if (peb32Address == IntPtr.Zero) return null;

            // Read ProcessParameters pointer from PEB32 (offset 0x10 on x86)
            byte[] buffer = new byte[4];
            int bytesRead;
            IntPtr processParametersOffset = IntPtr.Add(peb32Address, 0x10);
            if (!ReadProcessMemory(hProcess, processParametersOffset, buffer, 4, out bytesRead) || bytesRead != 4)
                return null;

            IntPtr processParameters = (IntPtr)BitConverter.ToInt32(buffer, 0);
            if (processParameters == IntPtr.Zero) return null;

            // Read CurrentDirectory.DosPath UNICODE_STRING32 from ProcessParameters (offset 0x24 on x86)
            // UNICODE_STRING32: Length (2), MaxLength (2), Buffer (4) = 8 bytes
            byte[] unicodeStringBuffer = new byte[8];
            IntPtr currentDirOffset = IntPtr.Add(processParameters, 0x24);
            if (!ReadProcessMemory(hProcess, currentDirOffset, unicodeStringBuffer, 8, out bytesRead) || bytesRead != 8)
                return null;

            ushort length = BitConverter.ToUInt16(unicodeStringBuffer, 0);
            IntPtr cwdBuffer = (IntPtr)BitConverter.ToInt32(unicodeStringBuffer, 4);
            if (cwdBuffer == IntPtr.Zero || length == 0) return null;

            // Read the actual CWD string
            byte[] cwdBytes = new byte[length];
            if (!ReadProcessMemory(hProcess, cwdBuffer, cwdBytes, length, out bytesRead) || bytesRead != length)
                return null;

            string cwd = Encoding.Unicode.GetString(cwdBytes);
            // Remove trailing backslash if present
            return cwd.TrimEnd('\\');
        } finally {
            Marshal.FreeHGlobal(pebPtr);
        }
    }

    // =============================================================================
    // Blocking Process Detection
    // =============================================================================

    public class ProcessInfo {
        public int Pid;
        public string Name;
        public string CommandLine;
        public List<string> Files = new List<string>();
        public string Cwd;
    }

    // Scan all running processes for those with CWD under basePath
    // Used when directory is empty (no files for Restart Manager to detect)
    public static List<ProcessInfo> GetProcessesWithCwdUnder(string basePath) {
        var result = new List<ProcessInfo>();
        var seenPids = new HashSet<int>();
        
        foreach (var proc in System.Diagnostics.Process.GetProcesses()) {
            try {
                int pid = proc.Id;
                if (seenPids.Contains(pid)) continue;
                
                string cwd = GetProcessCwd(pid);
                if (cwd == null) continue;
                
                if (IsPathUnder(cwd, basePath)) {
                    seenPids.Add(pid);
                    result.Add(new ProcessInfo {
                        Pid = pid,
                        Name = proc.ProcessName
                    });
                }
            } catch {
                // Skip processes we can't access
            } finally {
                proc.Dispose();
            }
        }
        
        return result;
    }

    public static List<ProcessInfo> GetBlockingProcesses(string basePath) {
        var result = new List<ProcessInfo>();
        uint sessionHandle = 0;
        string sessionKey = Guid.NewGuid().ToString();

        int rmResult = RmStartSession(out sessionHandle, 0, sessionKey);
        if (rmResult != 0) return result;

        try {
            string[] files;
            try {
                files = Directory.GetFiles(basePath, "*", SearchOption.AllDirectories);
                if (files.Length > 1000) {
                    var limited = new string[1000];
                    Array.Copy(files, limited, 1000);
                    files = limited;
                }
            } catch {
                return result;
            }

            // If directory is empty, Restart Manager can't detect blocking processes
            // CWD-based detection is handled at the PowerShell level
            if (files.Length == 0) {
                RmEndSession(sessionHandle);
                return result;
            }

            rmResult = RmRegisterResources(sessionHandle, (uint)files.Length, files, 0, null, 0, null);
            if (rmResult != 0) return result;

            uint procInfoNeeded = 0;
            uint procInfoCount = 0;
            uint rebootReasons = 0;

            rmResult = RmGetList(sessionHandle, out procInfoNeeded, ref procInfoCount, null, ref rebootReasons);
            if (rmResult == 234) { // ERROR_MORE_DATA
                procInfoCount = procInfoNeeded;
                var procInfos = new RM_PROCESS_INFO[procInfoCount];
                rmResult = RmGetList(sessionHandle, out procInfoNeeded, ref procInfoCount, procInfos, ref rebootReasons);

                if (rmResult == 0 || rmResult == 234) {
                    var seenPids = new HashSet<int>();
                    foreach (var info in procInfos) {
                        int pid = (int)info.Process.dwProcessId;
                        if (pid != 0 && !seenPids.Contains(pid)) {
                            seenPids.Add(pid);
                            result.Add(new ProcessInfo {
                                Pid = pid,
                                Name = info.strAppName
                            });
                        }
                    }
                }
            }
        } finally {
            RmEndSession(sessionHandle);
        }

        return result;
    }

    // =============================================================================
    // Handle Enumeration
    // =============================================================================

    public class HandleInfo {
        public int ProcessId;
        public short Handle;
        public string DosPath;
    }

    public static List<HandleInfo> GetFileHandles(string basePath, HashSet<int> filterPids) {
        var handles = new List<HandleInfo>();
        int bufferSize = 0x10000;
        IntPtr buffer = Marshal.AllocHGlobal(bufferSize);

        try {
            int returnLength;
            int status;

            while ((status = NtQuerySystemInformation(SystemHandleInformationEx, buffer, bufferSize, out returnLength)) == STATUS_INFO_LENGTH_MISMATCH) {
                bufferSize *= 2;
                Marshal.FreeHGlobal(buffer);
                buffer = Marshal.AllocHGlobal(bufferSize);
            }

            if (status != 0) return handles;

            // SYSTEM_HANDLE_INFORMATION_EX starts with NumberOfHandles (IntPtr-sized)
            long handleCount = IntPtr.Size == 8 
                ? Marshal.ReadInt64(buffer) 
                : Marshal.ReadInt32(buffer);
            IntPtr handlePtr = IntPtr.Add(buffer, IntPtr.Size * 2); // Skip NumberOfHandles + Reserved
            int entrySize = Marshal.SizeOf(typeof(SYSTEM_HANDLE_ENTRY_EX));

            var processHandles = new Dictionary<int, IntPtr>();

            for (long i = 0; i < handleCount; i++) {
                var entry = (SYSTEM_HANDLE_ENTRY_EX)Marshal.PtrToStructure(IntPtr.Add(handlePtr, (int)(i * entrySize)), typeof(SYSTEM_HANDLE_ENTRY_EX));

                // UniqueProcessId is pointer-sized, convert to int
                int pid = (int)entry.UniqueProcessId.ToInt64();

                // Filter by blocking PIDs
                if (!filterPids.Contains(pid)) continue;

                IntPtr processHandle;
                if (!processHandles.TryGetValue(pid, out processHandle)) {
                    processHandle = OpenProcess(PROCESS_DUP_HANDLE, false, pid);
                    processHandles[pid] = processHandle;
                }

                if (processHandle == IntPtr.Zero) continue;

                IntPtr dupHandle;
                if (!DuplicateHandle(processHandle, entry.HandleValue, GetCurrentProcess(), out dupHandle, 0, false, 2)) {
                    continue;
                }

                try {
                    string name = GetObjectNameWithTimeout(dupHandle, 100); // 100ms timeout
                    if (name == null) continue;
                    if (!name.StartsWith("\\Device\\", StringComparison.OrdinalIgnoreCase)) continue;
                    string dosPath = ConvertToDosPath(name);
                    if (dosPath == null) continue;
                    if (!IsPathUnder(dosPath, basePath)) continue;
                    handles.Add(new HandleInfo {
                        ProcessId = pid,
                        Handle = (short)entry.HandleValue.ToInt64(),
                        DosPath = dosPath
                    });
                } finally {
                    CloseHandle(dupHandle);
                }
            }

            foreach (var h in processHandles.Values) {
                if (h != IntPtr.Zero) CloseHandle(h);
            }
        } finally {
            Marshal.FreeHGlobal(buffer);
        }

        return handles;
    }

    // =============================================================================
    // Handle Closing
    // =============================================================================

    public static List<string> CloseFileHandles(List<HandleInfo> handles) {
        var closed = new List<string>();
        var processHandles = new Dictionary<int, IntPtr>();

        foreach (var handle in handles) {
            IntPtr processHandle;
            if (!processHandles.TryGetValue(handle.ProcessId, out processHandle)) {
                processHandle = OpenProcess(PROCESS_DUP_HANDLE, false, handle.ProcessId);
                processHandles[handle.ProcessId] = processHandle;
            }

            if (processHandle == IntPtr.Zero) continue;

            IntPtr dummy;
            if (DuplicateHandle(processHandle, (IntPtr)handle.Handle, IntPtr.Zero, out dummy, 0, false, DUPLICATE_CLOSE_SOURCE)) {
                closed.Add(handle.DosPath);
            }
        }

        foreach (var h in processHandles.Values) {
            if (h != IntPtr.Zero) CloseHandle(h);
        }

        return closed;
    }
}
'@ -ErrorAction SilentlyContinue

    $workspacePath = [System.IO.Path]::GetFullPath($BasePath)

    # DetectCwd mode: only scan for processes with CWD under workspace
    if ($Action -eq 'DetectCwd') {
        $cwdProcesses = [BlockingProcessDetector]::GetProcessesWithCwdUnder($workspacePath)

        if ($cwdProcesses.Count -eq 0) {
            @{ blocking = @() } | ConvertTo-Json -Compress -Depth 4
            exit 0
        }

        # Enrich with command line
        $blocking = @()
        foreach ($proc in $cwdProcesses) {
            try {
                $cimProc = Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.Pid)" -ErrorAction SilentlyContinue
                if ($cimProc) { $proc.CommandLine = $cimProc.CommandLine }
            } catch {}
            if ([string]::IsNullOrEmpty($proc.CommandLine)) {
                $proc.CommandLine = $proc.Name
            }

            # Get relative CWD
            $cwd = [BlockingProcessDetector]::GetProcessCwd($proc.Pid)
            if ($cwd) {
                $normalizedCwd = [System.IO.Path]::GetFullPath($cwd).TrimEnd('\', '/')
                $normalizedBase = $workspacePath.TrimEnd('\', '/')
                if ($normalizedCwd.StartsWith($normalizedBase, [StringComparison]::OrdinalIgnoreCase)) {
                    if ($normalizedCwd.Length -eq $normalizedBase.Length) {
                        $proc.Cwd = "."
                    } elseif ($normalizedCwd[$normalizedBase.Length] -eq '\' -or $normalizedCwd[$normalizedBase.Length] -eq '/') {
                        $proc.Cwd = $normalizedCwd.Substring($normalizedBase.Length + 1)
                    }
                }
            }

            $blocking += @{
                pid = $proc.Pid
                name = $proc.Name
                commandLine = $proc.CommandLine
                files = @()
                cwd = $proc.Cwd
            }
        }

        @{ blocking = $blocking } | ConvertTo-Json -Compress -Depth 4
        exit 0
    }

    # Step 1: Detect blocking processes using Restart Manager
    $blockingProcesses = [BlockingProcessDetector]::GetBlockingProcesses($workspacePath)

    # Step 1b: Also scan for CWD-based processes (always, not just when dir is empty)
    $seenPids = New-Object 'System.Collections.Generic.HashSet[int]'
    foreach ($proc in $blockingProcesses) {
        [void]$seenPids.Add($proc.Pid)
    }
    $cwdProcesses = [BlockingProcessDetector]::GetProcessesWithCwdUnder($workspacePath)
    foreach ($cwdProc in $cwdProcesses) {
        if (-not $seenPids.Contains($cwdProc.Pid)) {
            [void]$seenPids.Add($cwdProc.Pid)
            $blockingProcesses.Add($cwdProc)
        }
    }

    if ($blockingProcesses.Count -eq 0) {
        $output = @{
            blocking = @()
        }
        if ($Action -eq 'CloseHandles') {
            $output.closed = @()
        }
        $output | ConvertTo-Json -Compress -Depth 4
        exit 0
    }

    # Get PIDs as HashSet for filtering
    $pidSet = New-Object 'System.Collections.Generic.HashSet[int]'
    foreach ($proc in $blockingProcesses) {
        [void]$pidSet.Add($proc.Pid)
    }

    # Step 2: Get file handles for blocking processes
    $fileHandles = [BlockingProcessDetector]::GetFileHandles($workspacePath, $pidSet)

    # Step 3: Get command line and CWD for each process, and assign files
    foreach ($proc in $blockingProcesses) {
        # Get command line
        try {
            $cimProc = Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.Pid)" -ErrorAction SilentlyContinue
            if ($cimProc) { $proc.CommandLine = $cimProc.CommandLine }
        } catch {}
        if ([string]::IsNullOrEmpty($proc.CommandLine)) {
            $proc.CommandLine = $proc.Name
        }

        # Get CWD and check if it's within workspace
        $cwd = [BlockingProcessDetector]::GetProcessCwd($proc.Pid)
        if ($cwd) {
            $normalizedCwd = [System.IO.Path]::GetFullPath($cwd).TrimEnd('\', '/')
            $normalizedBase = $workspacePath.TrimEnd('\', '/')
            if ($normalizedCwd.StartsWith($normalizedBase, [StringComparison]::OrdinalIgnoreCase)) {
                if ($normalizedCwd.Length -eq $normalizedBase.Length) {
                    $proc.Cwd = "."
                } elseif ($normalizedCwd[$normalizedBase.Length] -eq '\' -or $normalizedCwd[$normalizedBase.Length] -eq '/') {
                    $proc.Cwd = $normalizedCwd.Substring($normalizedBase.Length + 1)
                }
            }
        }

        # Assign files to this process (max 20)
        $procFiles = @()
        foreach ($handle in $fileHandles) {
            if ($handle.ProcessId -eq $proc.Pid -and $procFiles.Count -lt 20) {
                $relative = $handle.DosPath.Substring($workspacePath.Length).TrimStart('\', '/')
                if ($relative -and -not ($procFiles -contains $relative)) {
                    $procFiles += $relative
                }
            }
        }
        $proc.Files = $procFiles
    }

    # Step 4: For CloseHandles mode, close the handles
    $closedPaths = @()
    if ($Action -eq 'CloseHandles') {
        $closedList = [BlockingProcessDetector]::CloseFileHandles($fileHandles)
        $closedPaths = @($closedList)
    }

    # Build output
    $blocking = @()
    foreach ($proc in $blockingProcesses) {
        $blocking += @{
            pid = $proc.Pid
            name = $proc.Name
            commandLine = $proc.CommandLine
            files = @($proc.Files)
            cwd = $proc.Cwd
        }
    }

    $output = @{
        blocking = $blocking
    }
    if ($Action -eq 'CloseHandles') {
        $output.closed = $closedPaths
    }

    $output | ConvertTo-Json -Compress -Depth 4
    exit 0

} catch {
    Write-JsonError $_.Exception.Message
    exit 1
}
