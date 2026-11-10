//! Chrome Native Messaging host for the Meet extension.
//! Chrome sends length-prefixed JSON messages on stdin. The host forwards each message to
//! the running app over the app socket, and returns the recording state to the extension.

use anyhow::{bail, Result};
use tinta_core::protocol::{Request, Response};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
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

/// A message from the extension.
#[derive(Debug, PartialEq)]
enum Incoming {
    Message(Value),
    /// A message longer than `MAX_MESSAGE`. The host read its body and did not keep it.
    TooLarge,
}

/// Reads one message. Returns `None` at the end of the input. The host reads the body of a message
/// that is too large and discards it, so the next message starts at the correct position.
fn read_message(input: &mut impl Read) -> Result<Option<Incoming>> {
    let mut length = [0u8; 4];
    match input.read_exact(&mut length) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e.into()),
    }
    let length = u32::from_ne_bytes(length) as usize;
    if length > MAX_MESSAGE {
        let discarded = std::io::copy(&mut input.take(length as u64), &mut std::io::sink())?;
        if discarded < length as u64 {
            bail!("the input ended inside a message");
        }
        return Ok(Some(Incoming::TooLarge));
    }
    let mut body = vec![0u8; length];
    input.read_exact(&mut body)?;
    Ok(Some(Incoming::Message(serde_json::from_slice(&body)?)))
}

fn write_message(output: &mut impl Write, value: &Value) -> Result<()> {
    let body = serde_json::to_vec(value)?;
    output.write_all(&(body.len() as u32).to_ne_bytes())?;
    output.write_all(&body)?;
    output.flush()?;
    Ok(())
}

/// The app closed the connection.
#[derive(Debug)]
struct Closed;

impl std::fmt::Display for Closed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the app closed the connection")
    }
}

impl std::error::Error for Closed {}

/// The app closed the connection before it answered "hello". The app trusts only the host
/// in its own bundle, so this host is from another copy of the app, for example the copy before an update.
#[derive(Debug)]
struct Refused;

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the app does not trust this host")
    }
}

impl std::error::Error for Refused {}

fn closed(error: &anyhow::Error) -> bool {
    error.is::<Closed>()
        || error.downcast_ref::<std::io::Error>().is_some_and(|e| {
            matches!(e.kind(), std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset)
        })
}

struct AppLink {
    socket: PathBuf,
    stream: Option<(UnixStream, BufReader<UnixStream>)>,
    next_id: u64,
}

impl AppLink {
    /// Sends a request to the app. When the app closed an open connection, for example because it restarted,
    /// the host connects again one time.
    fn send(&mut self, method: &str, params: Value) -> Result<Value> {
        let connected = self.stream.is_some();
        match self.request(method, params.clone()) {
            Err(error) if connected && closed(&error) => self.request(method, params),
            result => result,
        }
    }

    fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        if self.stream.is_none() {
            let stream = UnixStream::connect(&self.socket)?;
            stream.set_read_timeout(Some(APP_TIMEOUT))?;
            let reader = BufReader::new(stream.try_clone()?);
            self.stream = Some((stream, reader));
            if let Err(error) = self.exchange("hello", json!({"client": "native-host"})) {
                self.stream = None;
                return Err(if closed(&error) { Refused.into() } else { error });
            }
        }
        let result = self.exchange(method, params);
        if matches!(&result, Err(error) if !error.is::<AppError>()) {
            self.stream = None;
        }
        result
    }

    fn exchange(&mut self, method: &str, params: Value) -> Result<Value> {
        self.next_id += 1;
        let request = Request { id: self.next_id, method: method.into(), params };
        let (stream, reader) = self.stream.as_mut().expect("connected");
        let mut line = serde_json::to_string(&request)?;
        line.push('\n');
        stream.write_all(line.as_bytes())?;
        let mut reply = String::new();
        if reader.read_line(&mut reply)? == 0 {
            return Err(Closed.into());
        }
        let response: Response = serde_json::from_str(&reply)?;
        if let Some(error) = response.error {
            return Err(AppError(error).into());
        }
        Ok(response.result.unwrap_or(Value::Null))
    }
}

fn main() -> Result<()> {
    let mut input = std::io::stdin().lock();
    let mut output = std::io::stdout().lock();
    let mut link = AppLink { socket: tinta_core::paths::socket_path(), stream: None, next_id: 0 };
    while let Some(incoming) = read_message(&mut input)? {
        let message = match incoming {
            Incoming::Message(message) => message,
            Incoming::TooLarge => {
                // The extension expects one answer for each message.
                eprintln!("tinta-native-host: a message is larger than {MAX_MESSAGE} bytes");
                write_message(&mut output, &json!({"type": "status", "app": true, "error": "the message is too large"}))?;
                continue;
            }
        };
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
                // The host exits, so the port to the extension closes. When the extension connects again,
                // Chrome starts the host from the manifest, and the app writes the manifest with its own host.
                if error.is::<Refused>() {
                    std::process::exit(1);
                }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;

    fn socket(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("tinta-host-{name}-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&path);
        path
    }

    fn link(socket: &std::path::Path) -> AppLink {
        AppLink { socket: socket.to_path_buf(), stream: None, next_id: 0 }
    }

    /// Answers `count` requests on one connection, then closes it.
    fn answer(listener: &UnixListener, count: usize) {
        let (stream, _) = listener.accept().unwrap();
        let mut writer = stream.try_clone().unwrap();
        let mut reader = BufReader::new(stream);
        for _ in 0..count {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            writeln!(writer, "{}", json!({"id": request["id"], "result": {"recording": false}})).unwrap();
        }
    }

    fn framed(body: &[u8]) -> Vec<u8> {
        let mut bytes = (body.len() as u32).to_ne_bytes().to_vec();
        bytes.extend_from_slice(body);
        bytes
    }

    #[test]
    fn reads_the_messages_that_it_writes() {
        let mut bytes = Vec::new();
        let first = json!({"type": "meet_state", "meeting_code": "abc-defg-hij", "title": "Reunión"});
        let second = json!({"type": "ping", "t": 1});
        write_message(&mut bytes, &first).unwrap();
        write_message(&mut bytes, &second).unwrap();
        let length = u32::from_ne_bytes(bytes[..4].try_into().unwrap()) as usize;
        assert_eq!(length, serde_json::to_vec(&first).unwrap().len());
        let mut input = bytes.as_slice();
        assert_eq!(read_message(&mut input).unwrap(), Some(Incoming::Message(first)));
        assert_eq!(read_message(&mut input).unwrap(), Some(Incoming::Message(second)));
        assert_eq!(read_message(&mut input).unwrap(), None);
    }

    #[test]
    fn discards_a_message_that_is_too_large_and_reads_the_next_message() {
        let large = format!("{{\"extra\":\"{}\"}}", "x".repeat(MAX_MESSAGE));
        let mut bytes = framed(large.as_bytes());
        bytes.extend(framed(br#"{"type":"ping"}"#));
        let mut input = bytes.as_slice();
        assert_eq!(read_message(&mut input).unwrap(), Some(Incoming::TooLarge));
        assert_eq!(read_message(&mut input).unwrap(), Some(Incoming::Message(json!({"type": "ping"}))));
        assert_eq!(read_message(&mut input).unwrap(), None);

        let limit = format!("\"{}\"", "x".repeat(MAX_MESSAGE - 2));
        let at_limit = framed(limit.as_bytes());
        assert!(matches!(read_message(&mut at_limit.as_slice()).unwrap(), Some(Incoming::Message(_))));
    }

    #[test]
    fn an_input_that_ends_inside_a_message_is_an_error() {
        let whole = framed(br#"{"type":"ping"}"#);
        assert!(read_message(&mut &whole[..whole.len() - 1]).is_err());
        // The end of the input inside the length is the end of the input.
        assert_eq!(read_message(&mut &whole[..2]).unwrap(), None);
        let mut large = ((MAX_MESSAGE + 10) as u32).to_ne_bytes().to_vec();
        large.extend_from_slice(b"short");
        assert!(read_message(&mut large.as_slice()).is_err());
    }

    #[test]
    fn a_message_without_a_body_is_an_error() {
        assert!(read_message(&mut framed(b"").as_slice()).is_err());
        assert!(read_message(&mut framed(b"not json").as_slice()).is_err());
    }

    #[test]
    fn refused_when_the_app_closes_before_hello() {
        let path = socket("refused");
        let listener = UnixListener::bind(&path).unwrap();
        let server = std::thread::spawn(move || drop(listener.accept().unwrap()));
        let error = link(&path).send("extension_message", json!({})).unwrap_err();
        server.join().unwrap();
        assert!(error.is::<Refused>(), "{error}");
    }

    #[test]
    fn connects_again_after_the_app_restarts() {
        let path = socket("restart");
        let listener = UnixListener::bind(&path).unwrap();
        let server = std::thread::spawn(move || {
            answer(&listener, 2);
            answer(&listener, 2);
        });
        let mut link = link(&path);
        link.send("extension_message", json!({})).unwrap();
        link.send("extension_message", json!({})).unwrap();
        server.join().unwrap();
    }

    #[test]
    fn not_refused_when_the_app_does_not_run() {
        let path = socket("missing");
        let error = link(&path).send("extension_message", json!({})).unwrap_err();
        assert!(!error.is::<Refused>(), "{error}");
    }
}
