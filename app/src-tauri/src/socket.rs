//! The app socket. Only the signed helper binaries next to the app can connect:
//! `tinta-mcp` for MCP tools and `tinta-native-host` for Meet extension messages.

use crate::{system, AppState, MCP_ENABLED_DEFAULT};
use anyhow::{bail, Result};
use tinta_core::protocol::{Request, Response};
use tinta_core::{paths, tools};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::io::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::Arc;

/// The maximum length of one request line.
const MAX_LINE_BYTES: u64 = 1 << 20;

pub fn serve(state: Arc<AppState>) -> Result<()> {
    let path = paths::socket_path();
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path)?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let state = state.clone();
            std::thread::spawn(move || {
                if let Err(error) = connection(state, stream) {
                    eprintln!("socket connection ended: {error}");
                }
            });
        }
    });
    Ok(())
}

fn connection(state: Arc<AppState>, stream: UnixStream) -> Result<()> {
    let peer = system::peer_path(stream.as_raw_fd());
    if !peer.as_deref().map(system::trusted_peer).unwrap_or(false) {
        bail!("{} is not a trusted Tinta helper", peer.map(|p| p.display().to_string()).unwrap_or_default());
    }
    let mut extension_connection = None;
    let result = requests(&state, stream, &mut extension_connection);
    if let Some(generation) = extension_connection {
        state.on_extension_disconnected(generation);
    }
    result
}

/// Answers the requests of one trusted connection. `extension_connection` receives the
/// connection number when the peer is the native host.
fn requests(state: &AppState, stream: UnixStream, extension_connection: &mut Option<u64>) -> Result<()> {
    let mut writer = stream.try_clone()?;
    let mut reader = BufReader::new(stream);
    let mut client = String::new();
    let mut session = String::new();
    let mut line = String::new();
    loop {
        line.clear();
        let read = (&mut reader).take(MAX_LINE_BYTES + 1).read_line(&mut line)?;
        if read == 0 {
            return Ok(());
        }
        if read as u64 > MAX_LINE_BYTES {
            bail!("a request is longer than {MAX_LINE_BYTES} bytes");
        }
        let request: Request = match serde_json::from_str(line.trim_end()) {
            Ok(r) => r,
            Err(e) => {
                writeln!(writer, "{}", serde_json::to_string(&Response::err(0, e))?)?;
                continue;
            }
        };
        let response = match request.method.as_str() {
            "hello" => {
                client = request.params["client"].as_str().unwrap_or_default().to_string();
                session = request.params["session"].as_str().unwrap_or("native-host").to_string();
                if client == "native-host" && extension_connection.is_none() {
                    *extension_connection = Some(state.extension_connected());
                }
                Response::ok(request.id, json!({"app": "tinta"}))
            }
            "tools_call" if client == "mcp" => tool_call(state, &session, request.id, &request.params),
            "extension_message" if client == "native-host" => {
                Response::ok(request.id, state.on_extension_message(&request.params))
            }
            other => Response::err(request.id, format!("method not allowed: {other}")),
        };
        writeln!(writer, "{}", serde_json::to_string(&response)?)?;
    }
}

fn tool_call(state: &AppState, session: &str, id: u64, params: &Value) -> Response {
    if state.setting("mcp_enabled", MCP_ENABLED_DEFAULT) != "true" {
        return Response::err(id, "MCP access is off in Tinta settings");
    }
    let name = params["name"].as_str().unwrap_or_default();
    let arguments = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
    // The app refuses to move a meeting to the trash while it records or processes the meeting.
    let busy = if name == "delete_meeting" {
        let target = arguments["meeting_id"].as_str().and_then(|m| tools::resolve(&state.db.lock().unwrap(), m).ok());
        target.and_then(|target| state.check_idle(&target, true).err())
    } else {
        None
    };
    let db = state.db.lock().unwrap();
    let outcome = match busy {
        Some(error) => Err(error),
        None => tools::call(&db, name, &arguments),
    };
    let (result, ids) = match &outcome {
        Ok((_, ids)) => ("ok".to_string(), ids.clone()),
        Err(error) => (format!("error: {error}"), arguments["meeting_id"].as_str().map(|s| vec![s.to_string()]).unwrap_or_default()),
    };
    let _ = db.log_access(session, name, &ids, &result);
    drop(db);
    if outcome.is_ok() && !tools::READ_ONLY.contains(&name) {
        for id in &ids {
            state.meeting_changed(id);
        }
    }
    state.emit("mcp_access", json!({"tool": name}));
    match outcome {
        Ok((value, _)) => Response::ok(id, value),
        Err(error) => Response::err(id, error),
    }
}
