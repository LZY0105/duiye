// 对页 — JNI 这一段。
//
// 只做三件事：把请求从 Java 端搬进来、在一条工作线程上交给服务、把结果搬回去。
// 它不认得 agent 也不认得 ocr，加第三种服务时这个文件一行都不用改。
//
// 线程：每个请求一条 std::thread，detach 掉。对「一次一件、几秒钟」的活这是最
// 简单也最不会错的做法——没有队列要维护，没有线程池的生命周期要对齐。真接上
// 模型之后如果需要排队，那是服务实现自己的事（handle 里怎么调度由它决定），
// 这一层不必跟着改。
//
// 一个请求只结束一次：done 和 fail 之后再调用会被丢掉。这条规矩放在桥里而不是
// 让每个实现自己数，因为数错的那一次会变成 Java 端一个永远等不到回音的请求，
// 或者一个已经回过话又再回一次的请求——后者在 JS 那边是一条已完成的 Promise
// 被再次 resolve，查起来非常费劲。

#include <jni.h>

#include <atomic>
#include <memory>
#include <string>
#include <thread>

#include "duiye_proxy.h"

namespace {

JavaVM* g_vm = nullptr;
jclass g_proxyClass = nullptr;   // 全局引用，NativeProxy 的类对象
jmethodID g_onEvent = nullptr;   // static void onNativeEvent(String, String, String)

/** 把当前线程挂到 JVM 上，用完再摘。工作线程不是 JVM 起的，必须自己 attach。 */
class AttachedEnv {
 public:
  AttachedEnv() {
    if (!g_vm) return;
    if (g_vm->GetEnv(reinterpret_cast<void**>(&env_), JNI_VERSION_1_6) == JNI_OK) return;
    if (g_vm->AttachCurrentThread(&env_, nullptr) == JNI_OK) attached_ = true;
    else env_ = nullptr;
  }
  ~AttachedEnv() {
    if (attached_ && g_vm) g_vm->DetachCurrentThread();
  }
  JNIEnv* get() const { return env_; }

 private:
  JNIEnv* env_ = nullptr;
  bool attached_ = false;
};

std::string toStd(JNIEnv* env, jstring value) {
  if (!value) return {};
  const char* raw = env->GetStringUTFChars(value, nullptr);
  std::string out(raw ? raw : "");
  if (raw) env->ReleaseStringUTFChars(value, raw);
  return out;
}

/** 一条结果消息送回 Java。 */
void emit(const std::string& requestId, const char* kind, const std::string& json) {
  AttachedEnv scope;
  JNIEnv* env = scope.get();
  if (!env || !g_proxyClass || !g_onEvent) return;

  jstring jId = env->NewStringUTF(requestId.c_str());
  jstring jKind = env->NewStringUTF(kind);
  jstring jJson = env->NewStringUTF(json.c_str());
  env->CallStaticVoidMethod(g_proxyClass, g_onEvent, jId, jKind, jJson);
  // 回调里如果抛了，留着不管会污染这条线程接下来的每一次 JNI 调用。
  if (env->ExceptionCheck()) env->ExceptionClear();
  env->DeleteLocalRef(jId);
  env->DeleteLocalRef(jKind);
  env->DeleteLocalRef(jJson);
}

/** 交给实现用的那一端；「只结束一次」的规矩在这里。 */
class JniSink : public duiye::Sink {
 public:
  explicit JniSink(std::string requestId) : requestId_(std::move(requestId)) {}

  void chunk(const std::string& json) override {
    if (finished_) return;
    emit(requestId_, "chunk", json);
  }

  void done(const std::string& json) override {
    if (finished_.exchange(true)) return;
    emit(requestId_, "done", json);
  }

  void fail(const std::string& code, const std::string& message) override {
    if (finished_.exchange(true)) return;
    // 转义，不是拼接。消息是实现方给的，里面有引号、反斜杠、换行都很正常——
    // 而拼坏的 JSON 到了 JS 那一侧会退成 {raw: ...}，error.code 变成 UNKNOWN，
    // 恰好在出错的时候把「为什么错」弄丢。
    emit(requestId_, "error",
         "{\"code\":" + duiye::jsonQuote(code)
         + ",\"message\":" + duiye::jsonQuote(message) + "}");
  }

 private:
  std::string requestId_;
  std::atomic<bool> finished_{false};
};

}  // namespace

extern "C" {

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
  g_vm = vm;
  JNIEnv* env = nullptr;
  if (vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6) != JNI_OK) return JNI_ERR;

  jclass local = env->FindClass("com/latexsnipper/app/proxy/NativeProxy");
  if (!local) {
    // 找不到类会留下一个待处理的异常。带着它返回，接下来这条线程上的每一次
    // JNI 调用都会在它上面绊倒。
    env->ExceptionClear();
    return JNI_ERR;
  }
  // 全局引用：工作线程上 FindClass 找不到应用自己的类（它用的是系统类加载器），
  // 所以这一个必须在这里、在主线程上拿到并留住。
  g_proxyClass = static_cast<jclass>(env->NewGlobalRef(local));
  env->DeleteLocalRef(local);
  // 按字符串找。发布版里 R8 会把这个方法改名（实测改成了 c），
  // proguard-rules.pro 里有一条 -keep 就是为它；删了那条，这里拿到的是 null，
  // 于是返回 JNI_ERR，整层安静地消失——而类名反倒还在，看起来像「库装上了却不动」。
  g_onEvent = env->GetStaticMethodID(
      g_proxyClass, "onNativeEvent",
      "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V");
  if (!g_onEvent) { env->ExceptionClear(); return JNI_ERR; }
  return JNI_VERSION_1_6;
}

JNIEXPORT jstring JNICALL
Java_com_latexsnipper_app_proxy_NativeProxy_nativeDescribe(JNIEnv* env, jclass) {
  return env->NewStringUTF(duiye::describeAll().c_str());
}

JNIEXPORT void JNICALL
Java_com_latexsnipper_app_proxy_NativeProxy_nativeSubmit(
    JNIEnv* env, jclass, jstring jService, jstring jOp, jstring jPayload, jstring jRequestId) {
  duiye::Request request;
  request.service = toStd(env, jService);
  request.op = toStd(env, jOp);
  request.payload = toStd(env, jPayload);
  request.requestId = toStd(env, jRequestId);

  auto sink = std::make_shared<JniSink>(request.requestId);
  // 服务名是从 JS 一路传下来的，里面可以是任何东西——所以它只作为被转义的数据
  // 出现在消息里，不参与拼 JSON 的结构。
  std::shared_ptr<duiye::Service> service = duiye::findService(request.service);
  if (!service) {
    sink->fail(duiye::kErrNoService, "no service named " + request.service);
    return;
  }

  // 从这里起就不在 JVM 的线程上了：request 按值拷进去，service 拿的是一份强
  // 引用——这期间别人可以换掉同名的实现，而正在跑的这一件活得让旧的那一位活到
  // 做完。
  std::thread([service, request, sink]() {
    service->handle(request, sink);
  }).detach();
}

JNIEXPORT void JNICALL
Java_com_latexsnipper_app_proxy_NativeProxy_nativeCancel(
    JNIEnv* env, jclass, jstring jService, jstring jRequestId) {
  auto service = duiye::findService(toStd(env, jService));
  if (service) service->cancel(toStd(env, jRequestId));
}

}  // extern "C"
