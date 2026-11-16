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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_installation_wait_does_not_consume_the_engine_startup_budget() {
        let remaining = startup_budget(Duration::from_secs(120), Duration::from_secs(300), true);
        assert_eq!(remaining, Duration::from_secs(120));
        let remaining = startup_budget(remaining, Duration::from_secs(110), false);
        assert_eq!(remaining, Duration::from_secs(10));
        assert!(startup_budget(remaining, Duration::from_secs(11), false).is_zero());
    }
}
