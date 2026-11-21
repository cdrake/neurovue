#include "bindings/bindings.h"
#import <UIKit/UIKit.h>
#import <objc/runtime.h>

// tao 0.35 runs in UIScene mode (Info.ios.plist sets
// UIApplicationSupportsMultipleScenes, required for the iOS 27 SDK; TN3187), but
// its TaoSceneDelegate drops two things we patch in here until tao handles them:
// - a file that cold-launches the app ("Open in", AirDrop) arrives only in the
//   connection options, which tao ignores; forward it to scene:openURLContexts:
//   (RunEvent::Opened), as a warm open already does.
// - iPad "New Window" (or a file opened while running) can connect a second,
//   blank scene; NeuroVue is one window, so it is folded back into the first.
// TaoSceneDelegate is registered lazily by Rust, so it is patched the first time
// tao hands it to UISceneConfiguration.

static IMP originalWillConnect;
static IMP originalSetDelegateClass;

static void willConnect(id self, SEL _cmd, UIScene *scene, UISceneSession *session,
                        UISceneConnectionOptions *options) {
	// Another scene is still up, so this is New Window or an iPad file open that
	// asked for its own window, not the main scene reconnecting after the system
	// let it go: hand any files to the main window, bring it back, close this one.
	UIApplication *app = UIApplication.sharedApplication;
	for (UIScene *mainScene in app.connectedScenes) {
		if (mainScene == scene) continue;
		if (options.URLContexts.count > 0) {
			[mainScene.delegate scene:mainScene openURLContexts:options.URLContexts];
		}
		[app requestSceneSessionActivation:mainScene.session
		                      userActivity:nil
		                           options:nil
		                      errorHandler:nil];
		[app requestSceneSessionDestruction:session options:nil errorHandler:nil];
		return;
	}
	((void (*)(id, SEL, UIScene *, UISceneSession *, UISceneConnectionOptions *))
	     originalWillConnect)(self, _cmd, scene, session, options);
	if (options.URLContexts.count > 0) {
		[(id<UISceneDelegate>)self scene:scene openURLContexts:options.URLContexts];
	}
}

static void setDelegateClass(id self, SEL _cmd, Class delegateClass) {
	((void (*)(id, SEL, Class))originalSetDelegateClass)(self, _cmd, delegateClass);
	if (!originalWillConnect && delegateClass) {
		Method method = class_getInstanceMethod(delegateClass,
		                                        @selector(scene:willConnectToSession:options:));
		if (method) originalWillConnect = method_setImplementation(method, (IMP)willConnect);
	}
}

int main(int argc, char * argv[]) {
	Method method = class_getInstanceMethod(UISceneConfiguration.class,
	                                        @selector(setDelegateClass:));
	originalSetDelegateClass = method_setImplementation(method, (IMP)setDelegateClass);
	ffi::start_app();
	return 0;
}
