package com.latexsnipper.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.latexsnipper.app.proxy.NativeProxyPlugin;

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
    /**
     * 原生代理层在这里挂上去。
     *
     * 必须在 super.onCreate 之前登记：Capacitor 是在 onCreate 里建桥并把插件
     * 注入到 WebView 的，晚一步网页那边就找不到它了。
     *
     * 这一句是整个 app 里唯一知道代理层存在的地方。它现在接的是两个空位——问它
     * 会诚实地说 UNIMPLEMENTED——以后接上模型或者 OCR，这里一个字都不用改。
     */
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativeProxyPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
