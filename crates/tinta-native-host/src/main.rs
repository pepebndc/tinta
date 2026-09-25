//! Chrome Native Messaging host for the Meet extension.
//! Chrome sends length-prefixed JSON messages on stdin. The host forwards each message to
//! the running app over the app socket, and returns the recording state to the extension.

use anyhow::{bail, Result};
use tinta_core::protocol::{Request, Response};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::time::Duration;

const MAX_MESSAGE: usize = 256 * 1024;
const APP_TIMEOUT: Duration = Duration::from_secs(3);

/// An error that the app returns. The app runs, so the connection stays open.
#[derive(Debug)]
struct AppError(String);

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for AppError {}

fn read_message(input: &mut impl Read) -> Result<Option<Value>> {
    let mut length = [0u8; 4];
    match input.read_exact(&mut length) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e.into()),
    }
    let length = u32::from_ne_bytes(length) as usize;
    if length > MAX_MESSAGE {
        bail!("message too large");
    }
    let mut body = vec![0u8; length];
    input.read_exact(&mut body)?;
    Ok(Some(serde_json::from_slice(&body)?))
}

fn write_message(output: &mut impl Write, value: &Value) -> Result<()> {
    let body = serde_json::to_vec(value)?;
    output.write_all(&(body.len() as u32).to_ne_bytes())?;
    output.write_all(&body)?;
    output.flush()?;
    Ok(())
}

struct AppLink {
    stream: Option<(UnixStream, BufReader<UnixStream>)>,
    next_id: u64,
}

impl AppLink {
    fn send(&mut self, method: &str, params: Value) -> Result<Value> {
        if self.stream.is_none() {
            let stream = UnixStream::connect(tinta_core::paths::socket_path())?;
            stream.set_read_timeout(Some(APP_TIMEOUT))?;
            let reader = BufReader::new(stream.try_clone()?);
            self.stream = Some((stream, reader));
            if let Err(error) = self.send("hello", json!({"client": "native-host"})) {
                self.stream = None;
                return Err(error);
            }
        }
        self.next_id += 1;
        let request = Request { id: self.next_id, method: method.into(), params };
        let result = (|| -> Result<Value> {
            let (stream, reader) = self.stream.as_mut().expect("connected");
            let mut line = serde_json::to_string(&request)?;
            line.push('\n');
            stream.write_all(line.as_bytes())?;
            let mut reply = String::new();
            if reader.read_line(&mut reply)? == 0 {
                bail!("the app closed the connection");
            }
            let response: Response = serde_json::from_str(&reply)?;
            if let Some(error) = response.error {
                return Err(AppError(error).into());
            }
            Ok(response.result.unwrap_or(Value::Null))
        })();
        if matches!(&result, Err(error) if !error.is::<AppError>()) {
            self.stream = None;
        }
        result
    }
}

fn main() -> Result<()> {
    let mut input = std::io::stdin().lock();
    let mut output = std::io::stdout().lock();
    let mut link = AppLink { stream: None, next_id: 0 };
    while let Some(message) = read_message(&mut input)? {
        match link.send("extension_message", message) {
            Ok(result) => {
                let status = json!({
                    "type": "status",
                    "app": true,
                    "recording": result["recording"].as_bool().unwrap_or(false),
                    "recording_since": result["recording_since"],
                });
                write_message(&mut output, &status)?;
            }
            Err(error) => {
                eprintln!("tinta-native-host: {error}");
                let status = if error.is::<AppError>() {
                    json!({"type": "status", "app": true, "error": error.to_string()})
                } else {
                    json!({"type": "status", "app": false, "recording": false})
                };
                write_message(&mut output, &status)?;
            }
        }
    }
    Ok(())
}
