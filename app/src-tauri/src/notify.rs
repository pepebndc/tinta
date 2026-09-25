//! Meeting reminders in the macOS Notification Center.
//!
//! The reminders need the app bundle. A development build that runs outside the bundle shows no reminders.

use block2::{DynBlock, RcBlock};
use objc2::rc::Retained;
use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{define_class, msg_send, AllocAnyThread};
use objc2_foundation::{NSArray, NSBundle, NSError, NSSet, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationAction,
    UNNotificationActionOptions, UNNotificationCategory, UNNotificationCategoryOptions,
    UNNotificationDefaultActionIdentifier, UNNotificationPresentationOptions, UNNotificationRequest,
    UNNotificationResponse, UNNotificationSound, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};
use std::sync::OnceLock;

/// The category of a meeting reminder. It has the join action.
const CATEGORY: &str = "meeting";
const JOIN_ACTION: &str = "join";
/// The prefix of the identifier of a reminder. The event ID follows it.
const PREFIX: &str = "event:";

/// The function that handles a click on a reminder. It gets the event ID.
type Handler = Box<dyn Fn(String) + Send + Sync>;

static HANDLER: OnceLock<Handler> = OnceLock::new();

define_class!(
    // SAFETY: NSObject has no subclassing requirements, and the delegate does not implement Drop.
    #[unsafe(super(NSObject))]
    #[name = "TintaNotificationDelegate"]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        /// Shows the reminder also when Tinta is the active app.
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            handler: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            let options = UNNotificationPresentationOptions::Banner
                | UNNotificationPresentationOptions::List
                | UNNotificationPresentationOptions::Sound;
            handler.call((options,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            handler: &DynBlock<dyn Fn()>,
        ) {
            let action = response.actionIdentifier();
            // SAFETY: The constant is a static NSString of the framework.
            let default = unsafe { UNNotificationDefaultActionIdentifier };
            let joins = *action == *default || action.to_string() == JOIN_ACTION;
            let identifier = response.notification().request().identifier().to_string();
            if let (true, Some(event)) = (joins, identifier.strip_prefix(PREFIX)) {
                if let Some(on_join) = HANDLER.get() {
                    on_join(event.to_string());
                }
            }
            handler.call(());
        }
    }
);

impl Delegate {
    fn new() -> Retained<Self> {
        let this = Self::alloc().set_ivars(());
        // SAFETY: The superclass is NSObject, and `init` is its designated initializer.
        unsafe { msg_send![super(this), init] }
    }
}

/// The notification center, when the app runs from its bundle. Outside a bundle, the center throws an exception.
fn center() -> Option<Retained<UNUserNotificationCenter>> {
    let bundle = NSBundle::mainBundle();
    let in_app = bundle.bundleIdentifier().is_some() && bundle.bundlePath().to_string().ends_with(".app");
    in_app.then(UNUserNotificationCenter::currentNotificationCenter)
}

/// Registers the reminder category and the click handler. The app calls this one time, at the start.
pub fn init(on_join: impl Fn(String) + Send + Sync + 'static) {
    let Some(center) = center() else { return };
    if HANDLER.set(Box::new(on_join)).is_err() {
        return;
    }
    // The center keeps a weak reference to its delegate, so the delegate stays for the life of the app.
    let delegate = Box::leak(Box::new(Delegate::new()));
    center.setDelegate(Some(ProtocolObject::from_ref(&**delegate)));
    let join = UNNotificationAction::actionWithIdentifier_title_options(
        &NSString::from_str(JOIN_ACTION),
        &NSString::from_str("Join and take notes"),
        UNNotificationActionOptions::Foreground,
    );
    let category = UNNotificationCategory::categoryWithIdentifier_actions_intentIdentifiers_options(
        &NSString::from_str(CATEGORY),
        &NSArray::from_retained_slice(&[join]),
        &NSArray::new(),
        UNNotificationCategoryOptions::empty(),
    );
    center.setNotificationCategories(&NSSet::from_retained_slice(&[category]));
}

/// Asks macOS to allow reminders. macOS shows its prompt only one time.
pub fn request_permission() {
    let Some(center) = center() else { return };
    let done = RcBlock::new(|_granted: Bool, _error: *mut NSError| {});
    center.requestAuthorizationWithOptions_completionHandler(
        UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
        &done,
    );
}

/// Shows a reminder for a calendar event. A click on it, or on its action, calls the click handler with the event ID.
pub fn remind(event_id: &str, title: &str, body: &str) {
    let Some(center) = center() else { return };
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setBody(&NSString::from_str(body));
    content.setSound(Some(&UNNotificationSound::defaultSound()));
    content.setCategoryIdentifier(&NSString::from_str(CATEGORY));
    let identifier = NSString::from_str(&format!("{PREFIX}{event_id}"));
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&identifier, &content, None);
    center.addNotificationRequest_withCompletionHandler(&request, None);
}
