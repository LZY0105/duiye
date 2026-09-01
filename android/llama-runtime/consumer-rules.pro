# The llama.cpp JNI entry points are invoked from com.arm.aichat.InferenceEngineImpl.
-keep class com.arm.aichat.** { *; }
-keepclasseswithmembernames class * {
    native <methods>;
}
