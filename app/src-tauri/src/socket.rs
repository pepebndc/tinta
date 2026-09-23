//! The app socket. Only the signed helper binaries next to the app can connect:
//! `tinta-mcp` for MCP tools and `tinta-native-host` for Meet extension messages.

use crate::{system, AppState};
use anyhow::Result;
use tinta_core::protocol::{Request, Response};
use tinta_core::{paths, tools};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::io::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::Arc;

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
    let trusted = peer.as_deref().map(system::trusted_peer).unwrap_or(false);
    let mut writer = stream.try_clone()?;
    let mut client = String::new();
    let mut session = String::new();
    for line in BufReader::new(stream).lines() {
        let line = line?;
        let request: Request = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                writeln!(writer, "{}", serde_json::to_string(&Response::err(0, e))?)?;
                continue;
            }
        };
        let response = if !trusted {
            Response::err(request.id, "this process is not a trusted Tinta helper")
        } else {
            match request.method.as_str() {
                "hello" => {
                    client = request.params["client"].as_str().unwrap_or_default().to_string();
                    session = request.params["session"].as_str().unwrap_or("native-host").to_string();
                    Response::ok(request.id, json!({"app": "tinta"}))
                }
                "tools_call" if client == "mcp" => tool_call(&state, &session, request.id, &request.params),
                "extension_message" if client == "native-host" => {
                    Response::ok(request.id, state.on_extension_message(&request.params))
                }
                other => Response::err(request.id, format!("method not allowed: {other}")),
            }
        };
        writeln!(writer, "{}", serde_json::to_string(&response)?)?;
    }
    Ok(())
}

fn tool_call(state: &AppState, session: &str, id: u64, params: &Value) -> Response {
    if state.setting("mcp_enabled", "true") != "true" {
        return Response::err(id, "MCP access is off in Tinta settings");
    }
    let name = params["name"].as_str().unwrap_or_default();
    let arguments = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
    let db = state.db.lock().unwrap();
    let outcome = tools::call(&db, name, &arguments);
    let (result, ids) = match &outcome {
        Ok((_, ids)) => ("ok".to_string(), ids.clone()),
        Err(error) => (format!("error: {error}"), arguments["meeting_id"].as_str().map(|s| vec![s.to_string()]).unwrap_or_default()),
    };
    let _ = db.log_access(session, name, &ids, &result);
    drop(db);
    for id in &ids {
        state.meeting_changed(id);
    }
    state.emit("mcp_access", json!({"tool": name}));
    match outcome {
        Ok((value, _)) => Response::ok(id, value),
        Err(error) => Response::err(id, error),
    }
}
