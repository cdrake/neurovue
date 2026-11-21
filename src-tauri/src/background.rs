// Keeps a transfer running for the few minutes iOS allows after the person
// leaves the app; without it a send, receive or export dies at suspension.

#[cfg(target_os = "ios")]
pub(crate) struct BackgroundTask(std::sync::Arc<std::sync::atomic::AtomicUsize>);

#[cfg(target_os = "ios")]
impl BackgroundTask {
    pub(crate) fn begin(name: &str) -> Self {
        use block2::RcBlock;
        use objc2_foundation::NSString;
        use std::sync::atomic::AtomicUsize;
        use std::sync::Arc;

        let id = Arc::new(AtomicUsize::new(invalid()));
        let expired = id.clone();
        // iOS kills the app if an expired task isn't ended.
        let handler = RcBlock::new(move || end(&expired));
        let task = app().beginBackgroundTaskWithName_expirationHandler(
            Some(&NSString::from_str(name)),
            Some(&handler),
        );
        id.store(task, std::sync::atomic::Ordering::SeqCst);
        Self(id)
    }
}

#[cfg(target_os = "ios")]
impl Drop for BackgroundTask {
    fn drop(&mut self) {
        end(&self.0);
    }
}

#[cfg(target_os = "ios")]
fn app() -> objc2::rc::Retained<objc2_ui_kit::UIApplication> {
    // SAFETY: Apple documents begin/endBackgroundTask as callable from any thread.
    objc2_ui_kit::UIApplication::sharedApplication(unsafe {
        objc2::MainThreadMarker::new_unchecked()
    })
}

#[cfg(target_os = "ios")]
fn invalid() -> usize {
    unsafe { objc2_ui_kit::UIBackgroundTaskInvalid }
}

/// Ends the task once, whether expiry or drop gets there first.
#[cfg(target_os = "ios")]
fn end(id: &std::sync::atomic::AtomicUsize) {
    let task = id.swap(invalid(), std::sync::atomic::Ordering::SeqCst);
    if task != invalid() {
        app().endBackgroundTask(task);
    }
}

#[cfg(not(target_os = "ios"))]
pub(crate) struct BackgroundTask;

#[cfg(not(target_os = "ios"))]
impl BackgroundTask {
    pub(crate) fn begin(_name: &str) -> Self {
        Self
    }
}
