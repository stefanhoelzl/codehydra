//! CodeHydra's native OS queries, loaded by the main process as a Node addon.
//!
//! Replaces the processes `ProcessRunner` used to spawn only to read OS state
//! (`ps`, `lsof`, `netstat`, PowerShell, `codehydra-procs.exe`). Every export
//! is async: the work runs on the libuv thread pool, never on the event loop.
//!
//! The OS calls are the libraries' — sysinfo (processes), listeners (sockets),
//! restart-manager (Windows file locks) — and what they report is passed on as
//! they report it. The one exception is `open_files` (Windows): no crate lists
//! the files a process holds open, so that module has `unsafe` of its own.
//! Everywhere else `unsafe` is a compile error. On Linux, `procfs` reads the
//! few `/proc` files the polled scans need itself, so they read only those.

#![deny(unsafe_code)]

mod once;
#[cfg(windows)]
#[allow(unsafe_code)]
mod open_files;
mod procfs;

use std::collections::HashSet;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use napi::bindgen_prelude::{AsyncTask, ToNapiValue, TypeName};
use napi::{Env, Error, Result, Status, Task};
use napi_derive::napi;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, ThreadKind, UpdateKind};

use crate::once::OncePerProcess;

/// Linux reads the command line, working directory, environment and sockets
/// it needs from `/proc` itself (`procfs`); elsewhere the libraries do.
const LINUX: bool = cfg!(target_os = "linux");

/// One process, as `ProcessSnapshotEntry` in `src/boundaries/platform/process.ts`.
#[napi(object, use_nullable = true)]
pub struct NativeProcess {
    pub pid: u32,
    /// 0 when the OS reported none.
    pub ppid: u32,
    pub name: String,
    /// Full command line, or the bare name when the OS did not report one.
    pub command_line: String,
    pub cwd: Option<String>,
    pub rss_bytes: f64,
    pub cpu_time_ms: Option<f64>,
    /// Epoch ms. sysinfo reports whole seconds.
    pub started_at: Option<f64>,
    pub env_value: Option<String>,
    /// The session id: on Windows the logon session, which another logged-in
    /// account does not share.
    pub session_id: Option<u32>,
}

/// What the process scan keeps between scans.
struct Scanner {
    sys: System,
    /// Linux: each process's command line and environment variable, read
    /// once, and the working directories refused.
    cache: procfs::ProcessCache,
    /// Off Linux: the processes sysinfo was asked for their command line, and
    /// for their environment. sysinfo takes an empty one for one never read,
    /// so a process the OS will not describe to us (another user's on macOS,
    /// a protected one on Windows) is otherwise asked again on every scan.
    asked_cmd: OncePerProcess<()>,
    asked_environ: OncePerProcess<()>,
}

fn scanner() -> Result<&'static Mutex<Scanner>> {
    static SCANNER: OnceLock<std::result::Result<Mutex<Scanner>, String>> = OnceLock::new();
    SCANNER
        .get_or_init(|| {
            System::new()
                .map(|sys| {
                    Mutex::new(Scanner {
                        sys,
                        cache: procfs::ProcessCache::default(),
                        asked_cmd: OncePerProcess::default(),
                        asked_environ: OncePerProcess::default(),
                    })
                })
                .map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(|e| Error::new(Status::GenericFailure, e.clone()))
}

/// Linux: whether this process may read `p`'s working directory and
/// environment. Kernel threads have neither; another user's process is
/// readable only as root. A read that cannot succeed fails anew on every
/// scan, so it is not tried.
fn readable(p: &sysinfo::Process, own: Option<&sysinfo::Uid>) -> bool {
    if p.thread_kind() == Some(ThreadKind::Kernel) {
        return false;
    }
    let Some(own) = own else { return true };
    is_root(own) || (p.user_id() == Some(own) && p.effective_user_id() == Some(own))
}

/// Whether `uid` is root, who may read any process. A uid is a number only on
/// Unix (a SID on Windows), so this is the one branch `cfg!()` cannot take.
#[cfg(unix)]
fn is_root(uid: &sysinfo::Uid) -> bool {
    **uid == 0
}

#[cfg(not(unix))]
fn is_root(_uid: &sysinfo::Uid) -> bool {
    false
}

fn lossy(value: &OsStr) -> String {
    value.to_string_lossy().into_owned()
}

/// The value of `name` in a `KEY=VALUE` environment block. Windows variable
/// names are case-insensitive; everywhere else they are not. Off Linux only:
/// Linux reads it itself (`procfs`).
fn env_lookup(environ: &[std::ffi::OsString], name: &str) -> Option<String> {
    environ.iter().find_map(|entry| {
        let entry = entry.to_string_lossy();
        let (key, value) = entry.split_once('=')?;
        let matches = if cfg!(windows) {
            key.eq_ignore_ascii_case(name)
        } else {
            key == name
        };
        matches.then(|| value.to_owned())
    })
}

/// The last path segment of argv[0]: what the process calls itself. Linux's
/// own name (`comm`) is cut at 15 bytes.
fn executable_name(argv0: Option<&OsStr>) -> Option<String> {
    let argv0 = argv0?.to_string_lossy();
    let segment = argv0.rsplit(['/', '\\']).next().unwrap_or(&argv0);
    (!segment.is_empty()).then(|| segment.to_owned())
}

/// Windows: the image name (`node.exe`). Elsewhere: argv[0]'s last segment,
/// falling back to the OS's own name.
fn process_name(p: &sysinfo::Process, cmd: &[String]) -> String {
    if cfg!(windows) {
        return lossy(p.name());
    }
    executable_name(cmd.first().map(OsStr::new)).unwrap_or_else(|| lossy(p.name()))
}

/// sysinfo hands out the command line already split into argv; on Windows,
/// quote the arguments that need it so the joined line still parses the same.
/// It is not the original text: redundant quotes and spacing are gone, and
/// processes that refuse memory reads (protected system ones) report no argv
/// at all, so their command line is the bare name.
fn quote_arg(arg: &str) -> String {
    if cfg!(windows) && (arg.is_empty() || arg.contains([' ', '\t'])) {
        format!("\"{arg}\"")
    } else {
        arg.to_owned()
    }
}

/// Off Linux: have sysinfo read the command line — and with `environ` the
/// environment — of the processes it has not been asked about yet, in one
/// refresh of just those. A refresh that does not ask keeps what sysinfo read.
fn ask_once(scanner: &mut Scanner, environ: bool) {
    let mut pending = Vec::new();
    for p in scanner.sys.processes().values() {
        let (pid, start, name) = (p.pid().as_u32(), p.start_time(), lossy(p.name()));
        let mut new = false;
        let asked = [
            Some(&mut scanner.asked_cmd),
            environ.then_some(&mut scanner.asked_environ),
        ];
        for asked in asked.into_iter().flatten() {
            if asked.known(pid, start, &name).is_none() {
                asked.remember(pid, start, &name, ());
                new = true;
            }
        }
        if new {
            pending.push(p.pid());
        }
    }
    if pending.is_empty() {
        return;
    }
    let always = |ask: bool| {
        if ask {
            UpdateKind::Always
        } else {
            UpdateKind::Never
        }
    };
    let kind = ProcessRefreshKind::nothing()
        .without_tasks()
        .with_cmd(UpdateKind::Always)
        .with_environ(always(environ));
    scanner
        .sys
        .refresh_processes_specifics(ProcessesToUpdate::Some(&pending), false, kind);
}

fn list_processes(env_var: Option<&str>) -> Result<Vec<NativeProcess>> {
    let mut guard = scanner()?
        .lock()
        .map_err(|_| Error::new(Status::GenericFailure, "process table lock poisoned"))?;
    let scanner = &mut *guard;
    // The command line and environment are never part of the full refresh:
    // sysinfo would re-read every empty one on every scan. Linux reads them
    // below, and only from the processes that have them and can be read (the
    // uids that decide it come from the `status` file sysinfo reads anyway);
    // elsewhere `ask_once` has sysinfo read them once per process.
    let kind = ProcessRefreshKind::nothing()
        .without_tasks()
        .with_memory()
        .with_cpu();
    let kind = if LINUX {
        kind.with_user(UpdateKind::Always)
    } else {
        kind.with_cwd(UpdateKind::Always)
    };
    scanner
        .sys
        .refresh_processes_specifics(ProcessesToUpdate::All, true, kind);

    let alive: HashSet<u32> = scanner
        .sys
        .processes()
        .keys()
        .map(|pid| pid.as_u32())
        .collect();
    scanner.cache.retain(&alive);
    scanner.asked_cmd.retain(&alive);
    scanner.asked_environ.retain(&alive);
    if !LINUX {
        ask_once(scanner, env_var.is_some());
    }

    let own_uid = sysinfo::get_current_pid()
        .ok()
        .and_then(|pid| scanner.sys.process(pid))
        .and_then(|p| p.effective_user_id())
        .cloned();

    Ok(scanner
        .sys
        .processes()
        .values()
        // Kernel threads stay listed, as they always were; userland threads are
        // tasks, which `without_tasks` already skips.
        .filter(|p| p.thread_kind() != Some(ThreadKind::Userland))
        .map(|p| {
            let pid = p.pid().as_u32();
            let start = p.start_time();
            let os_name = lossy(p.name());
            // Linux: a kernel thread has no command line; anyone else's is
            // readable (it is world-readable).
            let cmd: Vec<String> = if !LINUX {
                p.cmd().iter().map(|a| lossy(a)).collect()
            } else if p.thread_kind() == Some(ThreadKind::Kernel) {
                Vec::new()
            } else {
                scanner.cache.cmdline(pid, start, &os_name).to_vec()
            };
            let name = process_name(p, &cmd);
            let command_line = if cmd.is_empty() {
                name.clone()
            } else {
                cmd.iter()
                    .map(|a| quote_arg(a))
                    .collect::<Vec<_>>()
                    .join(" ")
            };
            let (cwd, env_value) = if !LINUX {
                (
                    // As the OS reports it: Windows keeps a trailing `\` (`C:\work\`).
                    p.cwd().map(|c| c.to_string_lossy().into_owned()),
                    env_var.and_then(|name| env_lookup(p.environ(), name)),
                )
            } else if readable(p, own_uid.as_ref()) {
                (
                    scanner.cache.cwd(pid, start, &os_name),
                    env_var.and_then(|var| scanner.cache.env_value(var, pid, start, &os_name)),
                )
            } else {
                (None, None)
            };
            NativeProcess {
                pid,
                ppid: p.parent().map_or(0, |pid| pid.as_u32()),
                name,
                command_line,
                cwd,
                rss_bytes: p.memory() as f64,
                cpu_time_ms: Some(p.accumulated_cpu_time() as f64),
                started_at: (start > 0).then_some(start as f64 * 1000.0),
                env_value,
                session_id: p.session_id().map(|id| id.as_u32()),
            }
        })
        .collect())
}

/// One listening TCP socket.
#[napi(object)]
pub struct NativeListener {
    pub pid: u32,
    pub port: u32,
}

/// Every listening TCP socket with its owner, IPv4 and IPv6 alike — with
/// `pids`, only those the processes `pids` own. Sockets of processes the OS
/// will not describe to us (other users' on macOS) are missing.
fn listening_sockets(pids: Option<HashSet<u32>>) -> Result<Vec<NativeListener>> {
    // Linux: the library resolves every fd of every process to find the
    // owners; for a few pids, reading only theirs is a fraction of that.
    if LINUX && let Some(pids) = &pids {
        return Ok(procfs::listening_ports_of(pids)
            .into_iter()
            .map(|(pid, port)| NativeListener {
                pid,
                port: u32::from(port),
            })
            .collect());
    }
    let all =
        listeners::get_all().map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
    let mut seen = HashSet::new();
    Ok(all
        .into_iter()
        .filter(|l| l.protocol == listeners::Protocol::TCP)
        .filter(|l| l.state == listeners::SocketState::Listen)
        .filter(|l| {
            pids.as_ref()
                .is_none_or(|pids| pids.contains(&l.process.pid))
        })
        .filter_map(|l| {
            let key = (l.process.pid, l.socket.port());
            seen.insert(key).then_some(NativeListener {
                pid: key.0,
                port: u32::from(key.1),
            })
        })
        .collect())
}

/// A process Restart Manager names as holding a file.
#[napi(object)]
pub struct NativeFileHolder {
    pub pid: u32,
    pub name: String,
}

/// Restart Manager takes files, not directories: at most this many from the
/// tree, as the C# helper registered.
#[cfg_attr(not(windows), allow(dead_code))]
const MAX_RESTART_MANAGER_FILES: usize = 1000;

/// Up to `limit` files under `dir`, without following links into other trees.
#[cfg_attr(not(windows), allow(dead_code))]
fn files_under(dir: &Path, limit: usize) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut pending = vec![dir.to_path_buf()];
    while let Some(current) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                pending.push(entry.path());
            } else if kind.is_file() {
                files.push(entry.path());
                if files.len() >= limit {
                    return files;
                }
            }
        }
    }
    files
}

#[cfg(windows)]
fn restart_manager_holders(dir: &str) -> Result<Vec<NativeFileHolder>> {
    let failure = |e: restart_manager::Error| Error::new(Status::GenericFailure, e.to_string());
    let files = files_under(Path::new(dir), MAX_RESTART_MANAGER_FILES);
    if files.is_empty() {
        return Ok(Vec::new());
    }
    let mut session = restart_manager::RestartSession::new().map_err(failure)?;
    session.register_files(&files).map_err(failure)?;
    let affected = session.affected_applications().map_err(failure)?;
    session.end().map_err(failure)?;
    let mut seen = HashSet::new();
    Ok(affected
        .iter()
        .filter_map(|app| {
            let pid = app.process()?.pid();
            (pid != 0 && seen.insert(pid)).then(|| NativeFileHolder {
                pid,
                name: lossy(app.display_name()),
            })
        })
        .collect())
}

#[cfg(not(windows))]
fn restart_manager_holders(_dir: &str) -> Result<Vec<NativeFileHolder>> {
    Ok(Vec::new())
}

/// A file a process holds open.
#[napi(object)]
pub struct NativeOpenFile {
    pub pid: u32,
    /// Absolute path, as the OS spells it.
    pub path: String,
}

#[cfg(windows)]
fn open_files_under(dir: &str, pids: &HashSet<u32>) -> Vec<NativeOpenFile> {
    open_files::open_files_under(dir, pids)
        .into_iter()
        .map(|file| NativeOpenFile {
            pid: file.pid,
            path: file.path,
        })
        .collect()
}

#[cfg(not(windows))]
fn open_files_under(_dir: &str, _pids: &HashSet<u32>) -> Vec<NativeOpenFile> {
    Vec::new()
}

/// A blocking call run on the libuv thread pool; resolves with its result.
pub struct Job<T> {
    work: Option<Box<dyn FnOnce() -> Result<T> + Send>>,
}

impl<T> Job<T> {
    fn new(work: impl FnOnce() -> Result<T> + Send + 'static) -> AsyncTask<Self>
    where
        Self: Task,
    {
        AsyncTask::new(Job {
            work: Some(Box::new(work)),
        })
    }
}

impl<T: ToNapiValue + TypeName + Send + 'static> Task for Job<T> {
    type Output = T;
    type JsValue = T;

    fn compute(&mut self) -> Result<T> {
        let work = self
            .work
            .take()
            .ok_or_else(|| Error::new(Status::GenericFailure, "job already ran"))?;
        work()
    }

    fn resolve(&mut self, _env: Env, output: T) -> Result<T> {
        Ok(output)
    }
}

/// Every process on the machine. `envVar`: an environment variable to read
/// from each one (`envValue`).
#[napi]
pub fn list_processes_async(env_var: Option<String>) -> AsyncTask<Job<Vec<NativeProcess>>> {
    Job::new(move || list_processes(env_var.as_deref()))
}

/// Every listening TCP socket on the machine, with the pid that owns it.
/// `pids`: only the sockets these processes own.
#[napi]
pub fn listening_sockets_async(pids: Option<Vec<u32>>) -> AsyncTask<Job<Vec<NativeListener>>> {
    Job::new(move || listening_sockets(pids.map(|pids| pids.into_iter().collect())))
}

/// The processes Restart Manager says hold a file under `dir` (up to 1000 of
/// its files are registered). Windows only; empty elsewhere.
#[napi]
pub fn restart_manager_holders_async(dir: String) -> AsyncTask<Job<Vec<NativeFileHolder>>> {
    Job::new(move || restart_manager_holders(&dir))
}

/// The files under `dir` that the processes `pids` hold open, from the system
/// handle table. Windows only; empty elsewhere. Bounded: names that cannot be
/// resolved within a few seconds are left out.
#[napi]
pub fn open_files_under_async(dir: String, pids: Vec<u32>) -> AsyncTask<Job<Vec<NativeOpenFile>>> {
    Job::new(move || Ok(open_files_under(&dir, &pids.into_iter().collect())))
}
