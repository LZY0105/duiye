package com.latexsnipper.app;

import com.getcapacitor.BridgeActivity;

/**
 * The app is the Capacitor WebView and nothing else.
 *
 * It used to also install a NativeOcr JavaScript interface backed by an
 * on-device recognition stack. That stack is gone, and with it the only reason
 * this class was ever more than a declaration: the bridge was injected on a
 * retry loop because it had to exist before the web app booted.
 *
 * The web side still calls window.NativeOcr.addLog when it is there — see
 * src/core/logger.js — and every one of those calls is guarded, so with no
 * bridge to find they are no-ops rather than errors.
 */
public class MainActivity extends BridgeActivity {
}
