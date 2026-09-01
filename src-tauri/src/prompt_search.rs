use crate::AppError;
use rusqlite::InterruptHandle;
use std::{
    sync::{
        atomic::{AtomicU8, Ordering},
        mpsc::{self, Sender},
        Arc, Mutex,
    },
    thread::JoinHandle,
    time::Duration,
};

const ACTIVE: u8 = 0;
const SUPERSEDED: u8 = 1;
const TIMED_OUT: u8 = 2;

#[derive(Clone)]
pub(super) struct PromptSearchControl {
    interrupt: Arc<InterruptHandle>,
    reason: Arc<AtomicU8>,
}

impl PromptSearchControl {
    pub(super) fn classify_failure(&self, error: AppError) -> AppError {
        match self.reason.load(Ordering::SeqCst) {
            SUPERSEDED => AppError::new("prompt_search_cancelled", "搜索已被更新的查询取代。"),
            TIMED_OUT => AppError::new(
                "prompt_search_timeout",
                "搜索超过 1 秒，已取消。请缩小查询范围。",
            ),
            _ => error,
        }
    }
}

#[derive(Default)]
pub(super) struct PromptSearchCoordinator {
    active: Mutex<Option<PromptSearchControl>>,
}

impl PromptSearchCoordinator {
    pub(super) fn begin(&self, interrupt: Arc<InterruptHandle>) -> PromptSearchControl {
        let control = PromptSearchControl {
            interrupt,
            reason: Arc::new(AtomicU8::new(ACTIVE)),
        };
        let mut active = self.active.lock().expect("prompt search mutex poisoned");
        if let Some(previous) = active.replace(control.clone()) {
            previous.reason.store(SUPERSEDED, Ordering::SeqCst);
            previous.interrupt.interrupt();
        }
        control
    }

    pub(super) fn finish(&self, control: &PromptSearchControl) {
        let mut active = self.active.lock().expect("prompt search mutex poisoned");
        if active
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(&current.interrupt, &control.interrupt))
        {
            *active = None;
        }
    }
}

pub(super) fn spawn_watchdog(
    control: PromptSearchControl,
    timeout: Duration,
) -> (Sender<()>, JoinHandle<()>) {
    let (finished_tx, finished_rx) = mpsc::channel();
    let watchdog = std::thread::spawn(move || {
        if finished_rx.recv_timeout(timeout).is_err()
            && control
                .reason
                .compare_exchange(ACTIVE, TIMED_OUT, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
        {
            control.interrupt.interrupt();
        }
    });
    (finished_tx, watchdog)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn newer_search_supersedes_the_previous_run() {
        let first_connection = Connection::open_in_memory().unwrap();
        let second_connection = Connection::open_in_memory().unwrap();
        let coordinator = PromptSearchCoordinator::default();
        let first = coordinator.begin(Arc::new(first_connection.get_interrupt_handle()));
        let second = coordinator.begin(Arc::new(second_connection.get_interrupt_handle()));

        let error = first.classify_failure(AppError::new("sqlite_error", "interrupted"));

        assert_eq!(error.code, "prompt_search_cancelled");
        coordinator.finish(&second);
    }

    #[test]
    fn watchdog_timeout_has_a_distinct_error_contract() {
        let connection = Connection::open_in_memory().unwrap();
        let coordinator = PromptSearchCoordinator::default();
        let control = coordinator.begin(Arc::new(connection.get_interrupt_handle()));
        let (finished, watchdog) = spawn_watchdog(control.clone(), Duration::ZERO);

        watchdog.join().unwrap();
        drop(finished);
        let error = control.classify_failure(AppError::new("sqlite_error", "interrupted"));

        assert_eq!(error.code, "prompt_search_timeout");
        coordinator.finish(&control);
    }

    #[test]
    fn active_search_preserves_the_underlying_database_error() {
        let connection = Connection::open_in_memory().unwrap();
        let coordinator = PromptSearchCoordinator::default();
        let control = coordinator.begin(Arc::new(connection.get_interrupt_handle()));

        let error = control.classify_failure(AppError::new("sqlite_error", "fictional failure"));

        assert_eq!(error.code, "sqlite_error");
        assert_eq!(error.message, "fictional failure");
        coordinator.finish(&control);
    }

    #[test]
    fn completed_search_disarms_its_watchdog_without_reclassifying_errors() {
        let connection = Connection::open_in_memory().unwrap();
        let coordinator = PromptSearchCoordinator::default();
        let control = coordinator.begin(Arc::new(connection.get_interrupt_handle()));
        let (finished, watchdog) = spawn_watchdog(control.clone(), Duration::from_secs(1));

        finished.send(()).unwrap();
        watchdog.join().unwrap();
        let error = control.classify_failure(AppError::new("sqlite_error", "fictional failure"));

        assert_eq!(error.code, "sqlite_error");
        coordinator.finish(&control);
    }
}
