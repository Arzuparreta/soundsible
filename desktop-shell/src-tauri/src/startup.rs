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

#[cfg(test)]
mod tests {
    use super::*;

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
