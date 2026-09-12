package com.latexsnipper.app.proxy;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Java 这一侧的 JNI 端点。
 *
 * 只有它认得 native 方法，插件和别的地方都走它。分开是因为这两件事的失败方式
 * 完全不同：库装没装上是一次性的、进程级的；而一个请求成不成是每次都可能不同
 * 的。把它们混在一个类里，就会出现「插件加载失败」和「这次识别失败」共用一条
 * 错误路径。
 *
 * 库加载不上不抛异常。设备架构对不上、或者这个构建根本没开原生编译，都会走到
 * 这里——而那时 app 的其余部分本来就该照常工作：代理层是留着以后接东西的，不是
 * 读书必需的。available() 说实话，上层据此决定露不露那个入口。
 */
public final class NativeProxy {

    private static final boolean LOADED = load();

    /** requestId → 谁在等这条回音。 */
    private static final Map<String, EventSink> WAITING = new ConcurrentHashMap<>();

    /** 一条请求的回音落到哪里。 */
    public interface EventSink {
        void onEvent(String requestId, String kind, String json);
    }

    private NativeProxy() {}

    private static boolean load() {
        try {
            System.loadLibrary("duiye_proxy");
            return true;
        } catch (UnsatisfiedLinkError | SecurityException e) {
            // 没有原生库就是没有。这不是错误，是「还没接」。
            return false;
        }
    }

    public static boolean available() {
        return LOADED;
    }

    /** 现在装着哪些服务、各自什么样。库没加载时给出同样形状的一份答案。 */
    public static String describe() {
        if (!LOADED) {
            return "{\"services\":[],\"loaded\":false}";
        }
        return nativeDescribe();
    }

    /**
     * 交一件活下去。回音通过 sink 异步回来，可能先来若干条 chunk，最后必有一条
     * done 或 error。
     *
     * @return 收下了没有。false 只有一个原因：这个编号已经有一件活在飞。
     */
    public static boolean submit(String service, String op, String payload,
                                 String requestId, EventSink sink) {
        // 一个编号只能有一件活在飞。重号会让后来的那个 sink 顶掉前一个，于是
        // 前一件活的回音落到后一件手里——两边都错，而且错得没有痕迹。
        if (sink != null && WAITING.putIfAbsent(requestId, sink) != null) return false;
        if (!LOADED) {
            onNativeEvent(requestId, "error",
                    "{\"code\":\"NOT_LOADED\",\"message\":\"native proxy library is not present\"}");
            return true;
        }
        nativeSubmit(service, op, payload, requestId);
        return true;
    }

    public static void cancel(String service, String requestId) {
        if (LOADED) nativeCancel(service, requestId);
        // 取消之后不再等它的回音：实现可能拦不住，那条迟到的 done 不该再发出去。
        WAITING.remove(requestId);
    }

    /**
     * C++ 侧回话的入口。名字和签名被 jni_bridge.cpp 里的 JNI_OnLoad 按字符串
     * 找，改这两样必须两边一起改。
     */
    @SuppressWarnings("unused")   // 由 JNI 调用
    public static void onNativeEvent(String requestId, String kind, String json) {
        EventSink sink = "chunk".equals(kind) ? WAITING.get(requestId) : WAITING.remove(requestId);
        if (sink != null) sink.onEvent(requestId, kind, json);
    }

    private static native String nativeDescribe();

    private static native void nativeSubmit(String service, String op, String payload,
                                            String requestId);

    private static native void nativeCancel(String service, String requestId);
}
