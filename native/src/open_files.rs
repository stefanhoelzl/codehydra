//! Which files under a directory a set of processes hold open (Windows).
//!
//! The one place this crate has `unsafe` of its own (allowed on the module in
//! lib.rs). Windows reports open handles only through the undocumented system
//! handle table, and no crate wraps it, so this calls it directly — the port of
//! `GetFileHandles` from the former C# helper (codehydra-procs.exe):
//!
//! 1. `NtQuerySystemInformation(SystemExtendedHandleInformation)`: every handle
//!    on the system, with its owner pid and object type.
//! 2. Keep the handles of the asked-about pids whose type is "File" (the type
//!    index differs between Windows builds, so it is learnt from a file this
//!    process opens itself).
//! 3. `DuplicateHandle` each into this process and ask for its path.
//!
//! Asking for a handle's name can block forever (a synchronous pipe with a read
//! pending), so names are resolved on one worker thread under a deadline, as
//! the C# helper did: a query stuck past `NAME_QUERY_TIMEOUT` is abandoned with
//! its thread, and the rest continue on a fresh one, within `NAME_QUERY_BUDGET`
//! in total. `GetFileType` is asked first and only disk files are named, which
//! skips pipes — the handles that hang — before the query that would.

use std::collections::{HashMap, HashSet};
use std::ffi::c_void;
use std::fs::File;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use windows::Wdk::System::SystemInformation::{NtQuerySystemInformation, SYSTEM_INFORMATION_CLASS};
use windows::Win32::Foundation::{
    DUPLICATE_SAME_ACCESS, DuplicateHandle, HANDLE, STATUS_INFO_LENGTH_MISMATCH,
};
use windows::Win32::Storage::FileSystem::{
    FILE_NAME_NORMALIZED, FILE_TYPE_DISK, GETFINALPATHNAMEBYHANDLE_FLAGS, GetFileType,
    GetFinalPathNameByHandleW, VOLUME_NAME_DOS,
};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcess, PROCESS_DUP_HANDLE};

/// `SystemExtendedHandleInformation`: the handle table with full-width pids.
const SYSTEM_EXTENDED_HANDLE_INFORMATION: SYSTEM_INFORMATION_CLASS = SYSTEM_INFORMATION_CLASS(64);

/// Longest a single name query may take before its handle is presumed hung.
const NAME_QUERY_TIMEOUT: Duration = Duration::from_millis(500);

/// Budget for resolving names. The processes (what gets killed) are known
/// before this runs; running out of time returns the files found so far.
const NAME_QUERY_BUDGET: Duration = Duration::from_secs(5);

/// A normalized path with a drive letter: `C:\work\file`, not `\Device\HarddiskVolume3\...`.
const PATH_FLAGS: GETFINALPATHNAMEBYHANDLE_FLAGS =
    GETFINALPATHNAMEBYHANDLE_FLAGS(FILE_NAME_NORMALIZED.0 | VOLUME_NAME_DOS.0);

/// Upper bound for the handle table buffer: a misreported size must not
/// become an unbounded allocation.
const MAX_TABLE_BYTES: usize = 512 * 1024 * 1024;

/// `SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX`.
#[repr(C)]
#[derive(Clone, Copy)]
struct HandleEntry {
    object: usize,
    unique_process_id: usize,
    handle_value: usize,
    granted_access: u32,
    creator_back_trace_index: u16,
    object_type_index: u16,
    handle_attributes: u32,
    reserved: u32,
}

/// `SYSTEM_HANDLE_INFORMATION_EX` before its entries: `NumberOfHandles`, `Reserved`.
const TABLE_HEADER: usize = 2 * size_of::<usize>();

/// One file a process holds open.
pub struct OpenFile {
    pub pid: u32,
    /// DOS path, e.g. `C:\work\ws\file.txt`.
    pub path: String,
}

/// The files under `dir` that the processes `pids` hold open.
pub fn open_files_under(dir: &str, pids: &HashSet<u32>) -> Vec<OpenFile> {
    if pids.is_empty() {
        return Vec::new();
    }
    // A file this process opens itself, to learn the "File" type index. If it
    // cannot be opened every handle of the pids is tried instead (slower, same
    // answer: non-files fail GetFileType or have no path).
    let probe = std::env::current_exe().and_then(File::open).ok();
    let probe_handle = probe.as_ref().map(|file| file.as_raw_handle() as usize);

    let Some(table) = handle_table() else {
        return Vec::new();
    };
    let own_pid = std::process::id() as usize;
    let file_type = probe_handle.and_then(|value| {
        table
            .iter()
            .find(|entry| entry.unique_process_id == own_pid && entry.handle_value == value)
            .map(|entry| entry.object_type_index)
    });
    drop(probe);

    let candidates: Vec<HandleEntry> = table
        .into_iter()
        .filter(|entry| u32::try_from(entry.unique_process_id).is_ok_and(|pid| pids.contains(&pid)))
        .filter(|entry| file_type.is_none_or(|index| entry.object_type_index == index))
        .collect();

    let (owners, handles) = duplicate_into_self(&candidates);
    let names = resolve_names(handles);

    let prefix = format!("{}\\", dir.trim_end_matches(['\\', '/']).to_lowercase());
    owners
        .into_iter()
        .zip(names)
        .filter_map(|(pid, name)| {
            let path = name?;
            path.to_lowercase()
                .starts_with(&prefix)
                .then_some(OpenFile { pid, path })
        })
        .collect()
}

/// Every handle on the system; None when the query fails.
fn handle_table() -> Option<Vec<HandleEntry>> {
    let mut size: usize = 1024 * 1024;
    loop {
        // u64 words: the header and entries are pointer-aligned.
        let mut buffer = vec![0u64; size.div_ceil(8)];
        let byte_len = buffer.len() * 8;
        let mut needed = 0u32;
        // SAFETY: the buffer is writable for `byte_len` bytes, and the length
        // passed says so; `needed` is a valid out pointer.
        let status = unsafe {
            NtQuerySystemInformation(
                SYSTEM_EXTENDED_HANDLE_INFORMATION,
                buffer.as_mut_ptr().cast::<c_void>(),
                u32::try_from(byte_len).ok()?,
                &mut needed,
            )
        };
        if status == STATUS_INFO_LENGTH_MISMATCH {
            // The table grows between calls: ask for headroom.
            size = (needed as usize).max(size * 2) + 64 * 1024;
            if size > MAX_TABLE_BYTES {
                return None;
            }
            continue;
        }
        if status.is_err() {
            return None;
        }
        let bytes = byte_len.min(needed as usize);
        if bytes < TABLE_HEADER {
            return None;
        }
        let count = buffer[0] as usize;
        if count > (bytes - TABLE_HEADER) / size_of::<HandleEntry>() {
            return None;
        }
        // SAFETY: the buffer holds `count` entries after the header (checked
        // against the bytes written above); it is 8-aligned, as the header
        // size and the entries' alignment are; and HandleEntry is plain data
        // valid for any bit pattern.
        let entries = unsafe {
            std::slice::from_raw_parts(
                buffer
                    .as_ptr()
                    .cast::<u8>()
                    .add(TABLE_HEADER)
                    .cast::<HandleEntry>(),
                count,
            )
        };
        return Some(entries.to_vec());
    }
}

/// Copy each handle into this process: (owner pid, our copy) for those that could be.
fn duplicate_into_self(entries: &[HandleEntry]) -> (Vec<u32>, Vec<OwnedHandle>) {
    let mut processes: HashMap<u32, Option<OwnedHandle>> = HashMap::new();
    let mut owners = Vec::new();
    let mut handles = Vec::new();
    for entry in entries {
        let Ok(pid) = u32::try_from(entry.unique_process_id) else {
            continue;
        };
        let process = processes.entry(pid).or_insert_with(|| {
            // SAFETY: OpenProcess has no memory preconditions; a handle it
            // returns is owned by us, and OwnedHandle closes it once.
            unsafe { OpenProcess(PROCESS_DUP_HANDLE, false, pid) }
                .ok()
                .map(|handle| unsafe { OwnedHandle::from_raw_handle(handle.0) })
        });
        let Some(process) = process else {
            continue;
        };
        let mut copy = HANDLE::default();
        // SAFETY: `process` is a live handle with PROCESS_DUP_HANDLE; the
        // source value is only interpreted by the kernel, in that process; and
        // `copy` is a valid out pointer.
        let duplicated = unsafe {
            DuplicateHandle(
                HANDLE(process.as_raw_handle()),
                HANDLE(entry.handle_value as *mut c_void),
                GetCurrentProcess(),
                &mut copy,
                0,
                false,
                DUPLICATE_SAME_ACCESS,
            )
        };
        if duplicated.is_ok() {
            owners.push(pid);
            // SAFETY: DuplicateHandle succeeded, so `copy` is a new handle owned by us.
            handles.push(unsafe { OwnedHandle::from_raw_handle(copy.0) });
        }
    }
    (owners, handles)
}

/// The DOS path of a disk-file handle; None for anything else, or when Windows will not say.
fn path_of(handle: &OwnedHandle) -> Option<String> {
    let handle = HANDLE(handle.as_raw_handle());
    // SAFETY: `handle` is a live handle we own for the duration of the call.
    if unsafe { GetFileType(handle) } != FILE_TYPE_DISK {
        return None;
    }
    let mut buffer = vec![0u16; 512];
    loop {
        // SAFETY: `handle` is live; the slice is the writable buffer and its
        // length is the capacity the call is told about.
        let len = unsafe { GetFinalPathNameByHandleW(handle, &mut buffer, PATH_FLAGS) } as usize;
        if len == 0 {
            return None;
        }
        if len > buffer.len() {
            // Too small: `len` is the size needed, terminator included.
            buffer.resize(len, 0);
            continue;
        }
        let path = String::from_utf16_lossy(&buffer[..len]);
        return Some(match path.strip_prefix(r"\\?\UNC\") {
            Some(share) => format!(r"\\{share}"),
            None => path
                .strip_prefix(r"\\?\")
                .map(str::to_owned)
                .unwrap_or(path),
        });
    }
}

/// What the name worker and the watcher share.
struct Progress {
    /// Index being queried, and since when.
    current: usize,
    started: Instant,
    /// Set by the watcher: the worker must stop and touch nothing more.
    abandoned: bool,
    names: Vec<Option<String>>,
}

/// The path of each handle, under the deadlines above.
///
/// The worker takes each handle out of the list before it queries it and
/// closes it once the query returns, so a query that hangs keeps only its own
/// handle, on the abandoned thread's stack: it is leaked rather than closed,
/// since closing a handle another thread is blocked on can block the closer
/// too. Handles never reached are closed here at the end.
fn resolve_names(handles: Vec<OwnedHandle>) -> Vec<Option<String>> {
    let count = handles.len();
    let handles: Arc<Vec<Mutex<Option<OwnedHandle>>>> = Arc::new(
        handles
            .into_iter()
            .map(|handle| Mutex::new(Some(handle)))
            .collect(),
    );
    let budget = Instant::now() + NAME_QUERY_BUDGET;
    let mut names = vec![None; count];
    let mut next = 0;

    while next < count && Instant::now() < budget {
        let progress = Arc::new(Mutex::new(Progress {
            current: next,
            started: Instant::now(),
            abandoned: false,
            names: vec![None; count],
        }));
        let worker = {
            let progress = Arc::clone(&progress);
            let handles = Arc::clone(&handles);
            let first = next;
            thread::spawn(move || {
                for index in first..handles.len() {
                    {
                        let Ok(mut state) = progress.lock() else {
                            return;
                        };
                        if state.abandoned {
                            return;
                        }
                        state.current = index;
                        state.started = Instant::now();
                    }
                    let handle = handles[index].lock().ok().and_then(|mut slot| slot.take());
                    let name = handle.as_ref().and_then(path_of);
                    drop(handle);
                    let Ok(mut state) = progress.lock() else {
                        return;
                    };
                    if state.abandoned {
                        return;
                    }
                    state.names[index] = name;
                }
            })
        };

        loop {
            if worker.is_finished() {
                next = count;
                break;
            }
            thread::sleep(Duration::from_millis(20));
            let Ok(mut state) = progress.lock() else {
                next = count;
                break;
            };
            let now = Instant::now();
            if now >= budget || now.duration_since(state.started) > NAME_QUERY_TIMEOUT {
                state.abandoned = true;
                next = if now >= budget {
                    count
                } else {
                    state.current + 1
                };
                break;
            }
        }

        if let Ok(state) = progress.lock() {
            for (slot, name) in names.iter_mut().zip(state.names.iter()) {
                if name.is_some() {
                    *slot = name.clone();
                }
            }
        }
    }

    // Close the handles no worker reached. A hung worker still holds the Arc,
    // so the list itself may outlive this call; its slots are empty by then.
    for slot in handles.iter() {
        if let Ok(mut slot) = slot.try_lock() {
            drop(slot.take());
        }
    }
    names
}
