// 对页 — 原生代理层的接口。
//
// 这个文件是「预留」的那一部分：它规定了以后接进来的东西长什么样，而不包含
// 任何一个具体实现。现在挂着的是一个诚实的空实现（NullService），凡是问到它
// 的一律回 UNIMPLEMENTED——不是假装成功，也不是假装还在算。
//
// 为什么是这个形状：
//
// 一、一座桥，不是几座。AI 代理、OCR、答案匹配是三件不同的活，但它们对上层是
//     同一件事——「把一段东西交出去，等一段东西回来」。做成三套 JNI、三套插件、
//     三套线程模型，就会有三处要各自修的线程 bug。所以是一个 Service 接口，
//     几个实现，按名字挑。
//
// 二、结果是一段一段回来的，不是一次性回来的。一个只在算完才开口的模型，在
//     人这一侧和卡死没有区别；而 OCR 认一整页时也能先把认出来的行交出来。
//     Sink 的三个方法（chunk / done / fail）就是这件事，OCR 只用后两个也完全
//     成立——能分段的接口可以不分段用，反过来不行。
//
// 三、请求带 requestId，而且可以取消。人会在模型说到一半时改主意，会在 OCR
//     还在跑的时候翻页。没有取消的长任务最后都会变成「等它自己结束」。
//
// 四、载荷是 JSON 字符串，不是结构体。跨过 JNI 的东西每多一个字段就要在四处
//     各改一遍（C++ 结构体、JNI 转换、Java 类、JS）；而这一层本来就是转发，
//     它不需要看懂里面是什么。真正读这些字段的是两头，不是桥。
//
// 接一个实现进来，全部要做的是：
//
//   class OcrService : public duiye::Service {
//     const char* name() const override { return "ocr"; }
//     std::string describe() const override { return R"({"engine":"..."})"; }
//     void handle(const Request& req, std::shared_ptr<Sink> sink) override { ... }
//   };
//   duiye::registerService(std::make_shared<OcrService>());

#ifndef DUIYE_PROXY_H
#define DUIYE_PROXY_H

#include <memory>
#include <string>

namespace duiye {

/** 上层认得的几种服务。字符串而不是枚举：再加一种不必改这个头文件。 */
inline constexpr const char* kServiceAgent = "agent";
inline constexpr const char* kServiceOcr = "ocr";

/**
 * 答案匹配。
 *
 * 这一位和上面两位不一样：它**已经有一个能用的实现**，在 JS 那边
 * （question-matcher.js 的 matchPage，连带二十来个模块，在四本真实教材上
 * 508/508 零错误）。留这个位置是为了以后把那段计算搬到 C++ 来，不是为了填补
 * 一个空白。
 *
 * 所以接进来的实现要满足的不是「能跑」，而是「和现有那份算得一样」——
 * test/ 下那几套回归就是判据，换实现之后它们必须照样全绿。
 *
 * 契约写在 src/pdf/native-matcher.js：JS 那一侧的适配器已经写好，照着它期望的
 * 形状实现即可。**闸门不经过这一层**——角色判定、配对身份、OCR 上限、区域选择
 * 都留在 JS，而且 JS 会对这一层返回的结论再钳一次。这一层只打分，不下判断。
 */
inline constexpr const char* kServiceMatch = "match";

/** 约定好的几个错误码。实现可以自己再加，上层按字符串认。 */
inline constexpr const char* kErrUnimplemented = "UNIMPLEMENTED";
inline constexpr const char* kErrNoService = "NO_SUCH_SERVICE";
inline constexpr const char* kErrCancelled = "CANCELLED";
inline constexpr const char* kErrBadRequest = "BAD_REQUEST";

struct Request {
  std::string service;    // "agent" / "ocr" / "match"
  std::string op;         // 服务自己定义的动作，如 "chat" / "recognize" / "matchPage"
  std::string payload;    // JSON，桥不解析
  std::string requestId;  // 取消和配对用的，由上层生成
};

/**
 * 结果往回走的那一端。
 *
 * 实现方在自己的线程上调用它；发回上层这件事由桥负责，实现不需要知道 JNI 的
 * 存在。三个方法里 done 和 fail 都是终止的，之后再调用会被忽略——一个请求只
 * 结束一次，这条规矩由桥保证，实现不必自己数。
 */
class Sink {
 public:
  virtual ~Sink() = default;
  /** 一段中间结果。例如模型吐出来的一截文字、OCR 认出来的一行。 */
  virtual void chunk(const std::string& json) = 0;
  /** 完成。json 是最终结果。 */
  virtual void done(const std::string& json) = 0;
  /** 失败。code 用上面那几个，或者服务自己的。 */
  virtual void fail(const std::string& code, const std::string& message) = 0;
};

class Service {
 public:
  virtual ~Service() = default;
  /** 服务名，见上面那几个 kService*。 */
  virtual const char* name() const = 0;
  /** 这个服务现在是什么样，JSON。上层用它决定要不要露出相关的入口。 */
  virtual std::string describe() const = 0;
  /** 干活。可以同步干完，也可以自己开线程——桥不假设。 */
  virtual void handle(const Request& request, std::shared_ptr<Sink> sink) = 0;
  /** 取消一个还在跑的请求。默认什么都不做：不是每个服务都拦得住。 */
  virtual void cancel(const std::string& requestId) { (void)requestId; }
};

/**
 * 把一段文本放进 JSON 字符串里，连引号一起给。
 *
 * 桥自己往回送的那两样东西——错误码和错误消息——是拼出来的 JSON，而消息里很容易
 * 带引号、反斜杠、换行：一个文件路径、一句带引号的异常说明就够了。拼坏的 JSON
 * 在 JS 那一侧会被 catch 掉退成 {raw: ...}，于是 error.code 变成 UNKNOWN——恰好
 * 在出错的时候把「为什么错」丢掉。
 */
std::string jsonQuote(const std::string& text);

/** 装上一个实现。同名的会被替换，所以接入方不必先卸载空实现。 */
void registerService(std::shared_ptr<Service> service);

/**
 * 按名字找，找不到给空的。
 *
 * 给的是 shared_ptr 而不是裸指针：一件活可能在自己的线程上跑好几秒，而这期间
 * 别人可以 registerService 换掉同名的实现——登记处一松手，正在跑的那条线程手里
 * 就是个已经析构的对象。共享持有之后，旧的那一位会一直活到最后一件活做完。
 */
std::shared_ptr<Service> findService(const std::string& name);

/** 现在装着哪些服务、各自什么样。JSON，给上层探测用。 */
std::string describeAll();

}  // namespace duiye

#endif  // DUIYE_PROXY_H
