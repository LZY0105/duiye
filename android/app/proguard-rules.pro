# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# ── Capacitor plugin bridge ──
-keep class io.github.lzy0105.duiye.MainActivity { *; }

# ── Keep JNI / native methods ──
-keepclasseswithmembernames class * {
    native <methods>;
}

# ── 原生代理层：C++ 是按字符串找回调的 ──
#
# 上面那条只保住 native 方法本身。而 NativeProxy.onNativeEvent 不是 native
# 方法，它是一个普通的静态方法，C++ 那边是按字符串找它的：
# GetStaticMethodID(cls, "onNativeEvent", "(...)V")。
#
# 拿掉这条规则实测过：R8 不会删它（它经由 NativeProxy.submit 可达），而是把它
# 改名成 c —— mapping.txt 里那一行是
#     void onNativeEvent(java.lang.String,java.lang.String,java.lang.String) -> c
# 于是 GetStaticMethodID 返回 null，JNI_OnLoad 返回 JNI_ERR，System.loadLibrary
# 抛 UnsatisfiedLinkError，NativeProxy.available() 从此永远是 false。
#
# 而且是安静地。类名反而保住了（上面那条 native 规则顺带保的），所以看起来
# 「类在、库在、就是不工作」。debug 构建不混淆，这件事只在发布版里发生。
-keep class io.github.lzy0105.duiye.proxy.NativeProxy {
    *;
}
