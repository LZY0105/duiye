// Global error capture.
//
// Two jobs, both aimed at a real device rather than a desktop browser.
//
// First, diagnosis. Without this, a thrown error or a rejected promise vanishes
// into a WebView console nobody is attached to, and the only symptom is that
// something silently did not happen. Errors are forwarded into the native log
// buffer, so they come out through the existing "export logs" button — which is
// reachable on a tablet with no cable attached.
//
// Second, containment. An error escaping an event handler can leave the UI in a
// half-updated state with no indication anything went wrong. Surfacing it is
// better than a page that merely stops responding.
//
// It deliberately does NOT swallow errors: they are still logged to the console
// and still reach any debugger. This only guarantees they are also recorded.

let installed = false;
let recent = [];
const MAX_RECENT = 25;

function toNative(tag, message) {
  try {
    const bridge = typeof window !== 'undefined' ? window.NativeOcr : null;
    if (bridge && typeof bridge.addLog === 'function') bridge.addLog(`[${tag}] ${message}`);
  } catch (_) {
    // The bridge itself failing must not become a second error to report.
  }
}

function describe(value) {
  if (!value) return String(value);
  if (value instanceof Error) {
    return `${value.name}: ${value.message}\n${value.stack || '(no stack)'}`;
  }
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

function record(kind, detail) {
  const entry = { kind, detail, at: Date.now() };
  recent.push(entry);
  if (recent.length > MAX_RECENT) recent.shift();
  // console.error keeps normal debugging intact; the native log makes it
  // retrievable from a device with no tooling attached.
  console.error(`[${kind}]`, detail);
  toNative(kind, detail);
}

/** Everything captured this session, for a diagnostics screen. */
export function recentErrors() {
  return [...recent];
}

export function clearRecentErrors() {
  recent = [];
}

/** Idempotent; safe to call from more than one entry point. */
export function installCrashGuard() {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  window.addEventListener('error', (event) => {
    // Resource errors (a missing script or stylesheet) surface here with no
    // `error` object but a target — worth reporting, since a vendor script
    // failing to load is exactly the kind of fault that looks like a silent
    // feature outage.
    if (!event.error && event.target && event.target !== window) {
      const el = event.target;
      const src = el.src || el.href || '(unknown)';
      record('RESOURCE_ERROR', `${el.tagName || '?'} failed to load: ${src}`);
      return;
    }
    record('JS_ERROR', `${describe(event.error || event.message)} @ ${event.filename || '?'}:${event.lineno || 0}`);
  }, true); // capture phase: resource errors do not bubble

  window.addEventListener('unhandledrejection', (event) => {
    record('UNHANDLED_REJECTION', describe(event.reason));
  });
}
