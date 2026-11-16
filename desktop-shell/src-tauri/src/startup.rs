use serde::Deserialize;
use std::time::Duration;

pub(crate) fn startup_budget(
    remaining: Duration,
    elapsed: Duration,
    waiting_for_tools: bool,
) -> Duration {
    if waiting_for_tools {
        remaining
    } else {
        remaining.saturating_sub(elapsed)
    }
}

#[derive(Deserialize)]
struct StartupEvent {
    event: String,
    waiting: bool,
}

pub(crate) fn tools_wait_event(line: &str) -> Option<bool> {
    serde_json::from_str::<StartupEvent>(line)
        .ok()
        .filter(|event| event.event == "waiting_for_tools")
        .map(|event| event.waiting)
}

#[derive(Deserialize)]
struct ReadyEvent {
    event: String,
    launch_id: String,
    pid: u32,
}

pub(crate) fn ready_engine_pid(line: &str, launch_id: &str) -> Option<u32> {
    serde_json::from_str::<ReadyEvent>(line)
        .ok()
        .filter(|event| {
            event.event == "ready"
                && !launch_id.is_empty()
                && event.launch_id == launch_id
                && event.pid != 0
        })
        .map(|event| event.pid)
}

pub(crate) fn output_lines<R: std::io::Read>(stream: R, mut receive: impl FnMut(&str) -> bool) {
    use std::io::{BufRead, BufReader};

    let mut reader = BufReader::new(stream);
    let mut bytes = Vec::new();
    loop {
        bytes.clear();
        match reader.read_until(b'\n', &mut bytes) {
            Ok(0) | Err(_) => return,
            Ok(_) => {
                let line = String::from_utf8_lossy(&bytes);
                if !receive(line.trim_end_matches(['\r', '\n'])) {
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_owned_launch_can_report_its_python_pid() {
        let line = r#"{"event":"ready","launch_id":"own-launch","pid":43}"#;
        assert_eq!(ready_engine_pid(line, "own-launch"), Some(43));
        assert_eq!(ready_engine_pid(line, "another-launch"), None);
        assert_eq!(ready_engine_pid(line, ""), None);
        assert_eq!(
            ready_engine_pid(r#"{"event":"ready","pid":43}"#, "own-launch"),
            None
        );
    }

    #[test]
    fn legacy_codepage_logging_does_not_lose_the_following_startup_event() {
        let mut events = Vec::new();
        let mut logs = Vec::new();
        let bytes =
            b"M\xfasica \x97 starting\r\n{\"event\":\"waiting_for_tools\",\"waiting\":true}\n";
        output_lines(&bytes[..], |line| {
            logs.push(line.to_string());
            if let Some(event) = tools_wait_event(line) {
                events.push(event);
            }
            true
        });
        assert_eq!(logs.len(), 2);
        assert_eq!(events, [true]);
    }

    #[test]
    fn only_the_explicit_tool_wait_event_pauses_readiness() {
        assert_eq!(
            tools_wait_event(r#"{"event":"waiting_for_tools","waiting":true}"#),
            Some(true)
        );
        assert_eq!(
            tools_wait_event(r#"{"event":"waiting_for_tools","waiting":false}"#),
            Some(false)
        );
        assert_eq!(
            tools_wait_event(r#"{"event":"ready","waiting":true}"#),
            None
        );
        assert_eq!(tools_wait_event("log message"), None);
    }

    #[test]
    fn an_installation_wait_does_not_consume_the_engine_startup_budget() {
        let remaining = startup_budget(Duration::from_secs(120), Duration::from_secs(300), true);
        assert_eq!(remaining, Duration::from_secs(120));
        let remaining = startup_budget(remaining, Duration::from_secs(110), false);
        assert_eq!(remaining, Duration::from_secs(10));
        assert!(startup_budget(remaining, Duration::from_secs(11), false).is_zero());
    }
}
