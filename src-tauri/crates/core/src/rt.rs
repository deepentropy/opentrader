/*
 * The async runtime the core's background tasks run on. The desktop app
 * starts them from its setup hook, outside any ambient Tokio context, so the
 * host registers its runtime here first (`set_handle`); inside a runtime the
 * current one is used.
 */
use std::future::Future;
use std::sync::OnceLock;
use tokio::runtime::Handle;
use tokio::task::JoinHandle;

static HANDLE: OnceLock<Handle> = OnceLock::new();

/// Register the runtime for spawns made outside one. First call wins.
pub fn set_handle(handle: Handle) {
    let _ = HANDLE.set(handle);
}

fn handle() -> Handle {
    Handle::try_current()
        .ok()
        .or_else(|| HANDLE.get().cloned())
        .expect("no Tokio runtime: call opentrader_core::rt::set_handle first")
}

pub fn spawn<F>(future: F) -> JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    handle().spawn(future)
}
