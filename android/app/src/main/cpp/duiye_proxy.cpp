// 对页 — 服务登记处，和两个诚实的空实现。
//
// 空实现不是占位符里的 TODO：它是这座桥现在真实的状态。问它，它说
// UNIMPLEMENTED；问它是什么，它说自己没装。上层据此决定要不要露出入口，于是
// 「还没接」这件事在界面上是看得见的，而不是点下去之后不明不白地没反应。

#include "duiye_proxy.h"

#include <cstdio>
#include <map>
#include <mutex>
#include <sstream>
#include <vector>

namespace duiye {
namespace {

std::mutex& registryLock() {
  static std::mutex lock;
  return lock;
}

std::map<std::string, std::shared_ptr<Service>>& registry() {
  static std::map<std::string, std::shared_ptr<Service>> services;
  return services;
}

}  // namespace

std::string jsonQuote(const std::string& text) {
  std::string out = "\"";
  for (char c : text) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (static_cast<unsigned char>(c) < 0x20) {
          char buf[7];
          snprintf(buf, sizeof(buf), "\\u%04x", c);
          out += buf;
        } else {
          out += c;
        }
    }
  }
  return out + "\"";
}

namespace {

/**
 * 还没接上的那一位。
 *
 * 它照样出现在 describeAll 里，带着 "ready": false —— 上层需要知道「这个位置
 * 是留着的，只是还空着」，这和「根本没有这个东西」是两件事。
 */
class NullService : public Service {
 public:
  explicit NullService(const char* name) : name_(name) {}

  const char* name() const override { return name_; }

  std::string describe() const override {
    std::ostringstream out;
    out << "{\"name\":" << jsonQuote(name_)
        << ",\"ready\":false"
        << ",\"reason\":\"no implementation registered\"}";
    return out.str();
  }

  void handle(const Request& request, std::shared_ptr<Sink> sink) override {
    (void)request;
    sink->fail(kErrUnimplemented,
               std::string(name_) + " has no implementation registered yet");
  }

 private:
  const char* name_;
};

/** 第一次用到登记处时把几个空位摆好。 */
void ensureDefaults() {
  auto& all = registry();
  if (!all.empty()) return;
  all.emplace(kServiceAgent, std::make_shared<NullService>(kServiceAgent));
  all.emplace(kServiceOcr, std::make_shared<NullService>(kServiceOcr));
  // match 这一位空着不代表「没有匹配功能」——它现在由 JS 那份实现在跑。
  // 空的只是**原生的**那一份。上层据此决定要不要把计算交下来，而不是据此
  // 决定要不要露出功能。
  all.emplace(kServiceMatch, std::make_shared<NullService>(kServiceMatch));
}

}  // namespace

void registerService(std::shared_ptr<Service> service) {
  if (!service) return;
  std::lock_guard<std::mutex> guard(registryLock());
  ensureDefaults();
  // 同名替换，而不是拒绝：接入方不该为了装上自己的实现先去卸载那个空的。
  registry()[service->name()] = std::move(service);
}

std::shared_ptr<Service> findService(const std::string& name) {
  std::lock_guard<std::mutex> guard(registryLock());
  ensureDefaults();
  auto it = registry().find(name);
  return it == registry().end() ? nullptr : it->second;
}

std::string describeAll() {
  std::lock_guard<std::mutex> guard(registryLock());
  ensureDefaults();
  std::ostringstream out;
  out << "{\"services\":[";
  bool first = true;
  for (const auto& entry : registry()) {
    if (!first) out << ",";
    first = false;
    out << entry.second->describe();
  }
  out << "]}";
  return out.str();
}

}  // namespace duiye
