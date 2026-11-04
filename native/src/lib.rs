//! CodeHydra's native OS queries, loaded by the main process as a Node addon.
//!
//! Replaces the processes `ProcessRunner` used to spawn only to read OS state
//! (`ps`, `lsof`, `pgrep`, `getconf`, `codehydra-procs.exe`). Every export is
//! async: the work runs on the libuv thread pool, never on the event loop.
//!
//! No `unsafe` of our own: the OS calls are sysinfo's, and we take what it
//! reports as it reports it.

#![deny(unsafe_code)]

use std::ffi::OsStr;
use std::sync::{Mutex, OnceLock};

use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Error, Result, Status, Task};
use napi_derive::napi;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, ThreadKind, UpdateKind};

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
}

/// One `System`, kept between scans: sysinfo reads a process's command line and
/// environment once (they are fixed after exec) and only refreshes the rest.
fn system() -> Result<&'static Mutex<System>> {
    static SYSTEM: OnceLock<std::result::Result<Mutex<System>, String>> = OnceLock::new();
    SYSTEM
        .get_or_init(|| System::new().map(Mutex::new).map_err(|e| e.to_string()))
        .as_ref()
        .map_err(|e| Error::new(Status::GenericFailure, e.clone()))
}

fn lossy(value: &OsStr) -> String {
    value.to_string_lossy().into_owned()
}

/// The value of `name` in a `KEY=VALUE` environment block. Windows variable
/// names are case-insensitive; everywhere else they are not.
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
fn process_name(p: &sysinfo::Process) -> String {
    if cfg!(windows) {
        return lossy(p.name());
    }
    executable_name(p.cmd().first().map(|a| a.as_os_str())).unwrap_or_else(|| lossy(p.name()))
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

fn list_processes(env_var: Option<&str>) -> Result<Vec<NativeProcess>> {
    let mut sys = system()?
        .lock()
        .map_err(|_| Error::new(Status::GenericFailure, "process table lock poisoned"))?;
    let kind = ProcessRefreshKind::nothing()
        .without_tasks()
        .with_memory()
        .with_cpu()
        .with_cmd(UpdateKind::OnlyIfNotSet)
        .with_cwd(UpdateKind::Always)
        .with_environ(if env_var.is_some() {
            UpdateKind::OnlyIfNotSet
        } else {
            UpdateKind::Never
        });
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);

    Ok(sys
        .processes()
        .values()
        // Kernel threads stay listed, as they always were; userland threads are
        // tasks, which `without_tasks` already skips.
        .filter(|p| p.thread_kind() != Some(ThreadKind::Userland))
        .map(|p| {
            let cmd = p.cmd();
            let name = process_name(p);
            let command_line = if cmd.is_empty() {
                name.clone()
            } else {
                cmd.iter()
                    .map(|a| quote_arg(&lossy(a)))
                    .collect::<Vec<_>>()
                    .join(" ")
            };
            let start = p.start_time();
            NativeProcess {
                pid: p.pid().as_u32(),
                ppid: p.parent().map_or(0, |pid| pid.as_u32()),
                name,
                command_line,
                // As the OS reports it: Windows keeps a trailing `\` (`C:\work\`).
                cwd: p.cwd().map(|c| c.to_string_lossy().into_owned()),
                rss_bytes: p.memory() as f64,
                cpu_time_ms: Some(p.accumulated_cpu_time() as f64),
                started_at: (start > 0).then_some(start as f64 * 1000.0),
                env_value: env_var.and_then(|name| env_lookup(p.environ(), name)),
            }
        })
        .collect())
}

pub struct ListProcessesTask {
    env_var: Option<String>,
}

impl Task for ListProcessesTask {
    type Output = Vec<NativeProcess>;
    type JsValue = Vec<NativeProcess>;

    fn compute(&mut self) -> Result<Self::Output> {
        list_processes(self.env_var.as_deref())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Every process on the machine. `envVar`: an environment variable to read
/// from each one (`envValue`).
#[napi]
pub fn list_processes_async(env_var: Option<String>) -> AsyncTask<ListProcessesTask> {
    AsyncTask::new(ListProcessesTask { env_var })
}
