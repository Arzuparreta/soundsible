//! Generations identify work that still belongs to the current user intent.
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Default)]
pub struct Generation(AtomicU64);

impl Generation {
    pub const fn new() -> Self {
        Self(AtomicU64::new(0))
    }
    pub fn advance(&self) -> u64 {
        self.0.fetch_add(1, Ordering::SeqCst).wrapping_add(1)
    }
    pub fn is_current(&self, generation: u64) -> bool {
        self.0.load(Ordering::SeqCst) == generation
    }
    pub fn construct<T, E>(
        &self,
        generation: u64,
        create: impl FnOnce() -> Result<T, E>,
        discard: impl FnOnce(&T),
    ) -> Result<Option<T>, E> {
        if !self.is_current(generation) {
            return Ok(None);
        }
        let result = create();
        if !self.is_current(generation) {
            if let Ok(value) = result {
                discard(&value);
            }
            return Ok(None);
        }
        result.map(Some)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reentrant_cancellation_discards_the_just_created_resource() {
        let intent = Generation::new();
        let opening = intent.advance();
        let discarded = std::cell::Cell::new(false);
        let window = intent
            .construct(
                opening,
                || {
                    intent.advance(); // The native message pump dispatched Stop.
                    Ok::<_, ()>("created-window")
                },
                |_| discarded.set(true),
            )
            .unwrap();
        assert!(window.is_none());
        assert!(discarded.get());
    }

    #[test]
    fn a_cancelled_probe_cannot_commit_after_the_chooser_or_a_new_connection() {
        let intent = Generation::new();
        let first_probe = intent.advance();
        intent.advance(); // The user returns to the chooser while the probe waits.
        let mut saved_or_opened = false;
        if intent.is_current(first_probe) {
            saved_or_opened = true;
        }
        assert!(!saved_or_opened);
        let second_probe = intent.advance();
        assert!(!intent.is_current(first_probe));
        assert!(intent.is_current(second_probe));
    }

    #[test]
    fn reentrant_stop_invalidates_an_incomplete_native_window() {
        let intent = Generation::new();
        let opening = intent.advance();
        intent.advance(); // Native construction pumps a Stop shortcut.
        assert!(!intent.is_current(opening));
    }
}
