#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <iostream>
#include <optional>
#include <string>
#include <utility>

#include <httplib.h>
#include <nlohmann/json.hpp>

#include "upstream_http.h"

namespace {

using Json = nlohmann::json;

constexpr std::size_t kMaxQuestionBytes = 32 * 1024;
constexpr long kDefaultTimeoutMs = 60 * 1000;
constexpr char kDefaultOriginLocalhost[] = "http://localhost:5173";
constexpr char kDefaultOriginLoopback[] = "http://127.0.0.1:5173";
constexpr char kDefaultOriginCapacitor[] = "http://localhost";

enum class AgentMode {
    Mock,
    Upstream,
    Unconfigured,
    Invalid,
};

struct AgentConfig {
    AgentMode mode = AgentMode::Unconfigured;
    std::string apiKey;
    std::string model;
    std::string clientToken;
    std::optional<std::string> endpoint;
    long timeoutMs = kDefaultTimeoutMs;
};

std::optional<std::string> readEnvironment(const char* name) {
#ifdef _WIN32
    char* value = nullptr;
    std::size_t length = 0;
    if (_dupenv_s(&value, &length, name) != 0 || value == nullptr) {
        return std::nullopt;
    }

    std::string result(value);
    std::free(value);
    return result.empty() ? std::nullopt : std::optional<std::string>(std::move(result));
#else
    const char* value = std::getenv(name);
    if (value == nullptr || value[0] == '\0') return std::nullopt;
    return std::string(value);
#endif
}

std::string lower(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
        return static_cast<char>(std::tolower(ch));
    });
    return value;
}

std::string trim(std::string value) {
    const auto first = value.find_first_not_of(" \t\r\n");
    if (first == std::string::npos) return {};
    const auto last = value.find_last_not_of(" \t\r\n");
    return value.substr(first, last - first + 1);
}

long readTimeout() {
    const auto value = readEnvironment("DUIYE_AGENT_TIMEOUT_MS");
    if (!value) return kDefaultTimeoutMs;

    char* end = nullptr;
    const unsigned long parsed = std::strtoul(value->c_str(), &end, 10);
    if (end == value->c_str() || *end != '\0' || parsed < 1000 || parsed > 120000) {
        return kDefaultTimeoutMs;
    }
    return static_cast<long>(parsed);
}

AgentConfig readConfig() {
    AgentConfig config;
    config.timeoutMs = readTimeout();
    config.clientToken = readEnvironment("DUIYE_AGENT_CLIENT_TOKEN").value_or("");

    const std::string mode = lower(trim(readEnvironment("DUIYE_AGENT_MODE").value_or("")));
    if (mode == "mock") {
        config.mode = AgentMode::Mock;
        return config;
    }
    if (!mode.empty() && mode != "upstream") {
        config.mode = AgentMode::Invalid;
        return config;
    }

    const auto baseUrl = readEnvironment("DUIYE_AGENT_BASE_URL");
    const auto apiKey = readEnvironment("DUIYE_AGENT_API_KEY");
    const auto model = readEnvironment("DUIYE_AGENT_MODEL");
    if (!baseUrl || !apiKey || !model || apiKey->empty() || model->empty()) {
        config.mode = AgentMode::Unconfigured;
        return config;
    }

    config.endpoint = duiye::agent::completionUrl(*baseUrl);
    if (!config.endpoint) {
        config.mode = AgentMode::Invalid;
        return config;
    }

    config.mode = AgentMode::Upstream;
    config.apiKey = *apiKey;
    config.model = *model;
    return config;
}

const char* modeName(AgentMode mode) {
    switch (mode) {
        case AgentMode::Mock: return "mock";
        case AgentMode::Upstream: return "upstream";
        case AgentMode::Unconfigured: return "unconfigured";
        case AgentMode::Invalid: return "invalid";
    }
    return "invalid";
}

bool isAllowedOrigin(const std::string& origin) {
    if (origin.empty()) return true;

    if (origin == kDefaultOriginLocalhost
        || origin == kDefaultOriginLoopback
        || origin == kDefaultOriginCapacitor) {
        return true;
    }

    return origin == readEnvironment("DUIYE_AGENT_ALLOWED_ORIGIN").value_or("");
}

std::string requestOrigin(const httplib::Request& request) {
    return request.has_header("Origin") ? request.get_header_value("Origin") : "";
}

void writeCorsHeaders(httplib::Response& response, const std::string& origin) {
    if (origin.empty()) return;

    response.set_header("Access-Control-Allow-Origin", origin);
    response.set_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.set_header(
        "Access-Control-Allow-Headers",
        "Content-Type, X-Duiye-Agent-Token"
    );
    response.set_header("Access-Control-Max-Age", "600");
    response.set_header("Vary", "Origin");
}

void writeJson(
    httplib::Response& response,
    int status,
    const Json& body,
    const std::string& origin = ""
) {
    writeCorsHeaders(response, origin);
    response.status = status;
    response.set_header("Cache-Control", "no-store");
    response.set_content(body.dump(), "application/json; charset=utf-8");
}

void writeError(
    httplib::Response& response,
    int status,
    const std::string& code,
    const std::string& message,
    const std::string& origin = ""
) {
    writeJson(response, status, Json{
        {"version", 1},
        {"ok", false},
        {"error", code},
        {"message", message},
    }, origin);
}

bool authoriseClientToken(
    const httplib::Request& request,
    httplib::Response& response,
    const AgentConfig& config,
    const std::string& origin
) {
    // 未配置令牌时保留桌面本地开发模式；云端部署必须设置该环境变量。
    if (config.clientToken.empty()) return true;

    const bool tokenMatches = request.has_header("X-Duiye-Agent-Token")
        && request.get_header_value("X-Duiye-Agent-Token") == config.clientToken;
    if (tokenMatches) return true;

    writeError(response, 401, "invalid_client_token", "Agent 访问令牌无效。", origin);
    return false;
}

bool authoriseOrigin(const httplib::Request& request, httplib::Response& response) {
    const std::string origin = requestOrigin(request);
    if (isAllowedOrigin(origin)) return true;

    writeError(response, 403, "origin_not_allowed", "此网页来源无权调用 Agent 代理。");
    return false;
}

bool isJsonRequest(const httplib::Request& request) {
    if (!request.has_header("Content-Type")) return false;
    return request.get_header_value("Content-Type").rfind("application/json", 0) == 0;
}

std::optional<std::string> answerFromCompletion(const std::string& body) {
    try {
        const Json payload = Json::parse(body);
        const auto choices = payload.find("choices");
        if (choices == payload.end() || !choices->is_array() || choices->empty()) {
            return std::nullopt;
        }

        const auto message = choices->at(0).find("message");
        if (message == choices->at(0).end() || !message->is_object()) {
            return std::nullopt;
        }

        const auto content = message->find("content");
        if (content == message->end() || !content->is_string()) {
            return std::nullopt;
        }

        const std::string answer = trim(content->get<std::string>());
        return answer.empty() ? std::nullopt : std::optional<std::string>(answer);
    } catch (const Json::exception&) {
        return std::nullopt;
    }
}

Json createCompletionRequest(const Json& payload, const AgentConfig& config) {
    const std::string pageText =
        payload.at("questionText").get<std::string>();
    const long long page = payload.at("page").get<long long>();
    const std::string origin =
        payload.at("textOrigin").get<std::string>();

    std::string userPrompt = "以下是 PDF 第 " + std::to_string(page)
        + " 页提取的文字（来源：" + origin + "）：\n\n" + pageText;

    if (payload.contains("userQuestion")) {
        userPrompt += "\n\n用户问题：\n"
            + trim(payload.at("userQuestion").get<std::string>());
    }

    return Json{
        {"model", config.model},
        {"stream", false},
        {"max_tokens", 512},
        {"enable_thinking", false},
        {"messages", Json::array({
            {
                {"role", "system"},
                {"content",
                    "你是学习资料助手。只依据用户提供的 PDF 当前页文字回答，使用中文。"
                    "如果提供了“用户问题”，直接回答该问题并给出必要依据；"
                    "如果没有提供问题，则分析页面中唯一明确的问题并给出简洁解题思路。"
                    "若页面包含多题、依据不足或无法确定，必须明确说明，不得编造页面外事实。"},
            },
            {
                {"role", "user"},
                {"content", userPrompt},
            },
        })},
    };
}

bool validPayload(const Json& payload, httplib::Response& response, const std::string& origin) {
    if (!payload.contains("version") || !payload["version"].is_number_integer()
        || payload["version"].get<long long>() != 1) {
        writeError(response, 400, "invalid_version", "version 必须为 1。", origin);
        return false;
    }

    if (!payload.contains("page") || !payload["page"].is_number_integer()
        || payload["page"].get<long long>() < 1 || payload["page"].get<long long>() > 100000) {
        writeError(response, 400, "invalid_page", "page 必须是 1 到 100000 之间的整数。", origin);
        return false;
    }

    if (!payload.contains("questionText") || !payload["questionText"].is_string()) {
        writeError(response, 400, "invalid_question_text", "questionText 必须是字符串。", origin);
        return false;
    }

    const std::string text = payload["questionText"].get<std::string>();
    if (text.empty() || text.size() > kMaxQuestionBytes) {
        writeError(response, 400, "invalid_question_text", "questionText 长度必须在 1 到 32768 字节之间。", origin);
        return false;
    }

    if (payload.contains("userQuestion")) {
        if (!payload["userQuestion"].is_string()) {
            writeError(
                response,
                400,
                "invalid_user_question",
                "userQuestion 必须是字符串。",
                origin
            );
            return false;
        }

        const std::string userQuestion =
            trim(payload["userQuestion"].get<std::string>());

        if (userQuestion.empty() || userQuestion.size() > 2048) {
            writeError(
                response,
                400,
                "invalid_user_question",
                "userQuestion 长度必须在 1 到 2048 字节之间。",
                origin
            );
            return false;
        }
    }

    if (!payload.contains("textOrigin") || !payload["textOrigin"].is_string()
        || payload["textOrigin"].get<std::string>().empty()
        || payload["textOrigin"].get<std::string>().size() > 32) {
        writeError(response, 400, "invalid_text_origin", "textOrigin 必须是长度不超过 32 的字符串。", origin);
        return false;
    }

    return true;
}

} // namespace

int main() {
    const std::string listenHost = trim(
        readEnvironment("DUIYE_AGENT_LISTEN_HOST").value_or("127.0.0.1")
    );
    if (listenHost.empty()) {
        std::cerr << "DUIYE_AGENT_LISTEN_HOST 不能为空。" << std::endl;
        return 1;
    }

    httplib::Server server;
    server.set_payload_max_length(64 * 1024);

    const auto options = [](const httplib::Request& request, httplib::Response& response) {
        if (!authoriseOrigin(request, response)) return;
        writeCorsHeaders(response, requestOrigin(request));
        response.status = 204;
    };

    server.Options("/health", options);
    server.Options("/v1/agent/answer", options);

    server.Get("/health", [](const httplib::Request& request, httplib::Response& response) {
        if (!authoriseOrigin(request, response)) return;

        const std::string origin = requestOrigin(request);
        const AgentConfig config = readConfig();
        if (!authoriseClientToken(request, response, config, origin)) return;

        const bool ready = config.mode == AgentMode::Mock || config.mode == AgentMode::Upstream;
        writeJson(response, 200, Json{
            {"version", 1},
            {"ok", true},
            {"service", "agent-proxy"},
            {"ready", ready},
            {"mode", modeName(config.mode)},
        }, origin);
    });

    server.Post("/v1/agent/answer", [](const httplib::Request& request,
                                        httplib::Response& response) {
        if (!authoriseOrigin(request, response)) return;

        const std::string origin = requestOrigin(request);
        const AgentConfig config = readConfig();
        if (!authoriseClientToken(request, response, config, origin)) return;

        if (!isJsonRequest(request)) {
            writeError(response, 415, "unsupported_content_type",
                       "Content-Type 必须为 application/json。", origin);
            return;
        }

        Json payload;
        try {
            payload = Json::parse(request.body);
        } catch (const Json::exception&) {
            writeError(response, 400, "invalid_json", "请求体不是有效 JSON。", origin);
            return;
        }

        if (!validPayload(payload, response, origin)) return;

        if (config.mode == AgentMode::Unconfigured) {
            writeError(response, 503, "upstream_not_configured",
                       "Agent 代理尚未配置上游模型。", origin);
            return;
        }

        if (config.mode == AgentMode::Invalid) {
            writeError(response, 503, "invalid_proxy_configuration",
                       "Agent 代理配置无效。", origin);
            return;
        }

        if (config.mode == AgentMode::Mock) {
            writeJson(response, 200, Json{
                {"version", 1},
                {"ok", true},
                {"source", "cpp-mock"},
                {"answer", "C++ Agent mock 已收到第 "
                    + std::to_string(payload["page"].get<long long>()) + " 页文本。"},
            }, origin);
            return;
        }

        const Json upstreamRequest = createCompletionRequest(payload, config);
        const auto upstream = duiye::agent::postJson(
            *config.endpoint,
            config.apiKey,
            upstreamRequest.dump(),
            config.timeoutMs
        );

        if (!upstream.error.empty()) {
            writeError(
                response,
                upstream.timedOut ? 504 : 502,
                upstream.timedOut ? "upstream_timeout" : "upstream_unreachable",
                upstream.timedOut ? "上游模型响应超时。" : "无法连接上游模型。",
                origin
            );
            return;
        }

        if (upstream.status < 200 || upstream.status >= 300) {
            writeError(response, 502, "upstream_rejected",
                       "上游模型拒绝了请求（HTTP "
                           + std::to_string(upstream.status) + "）。", origin);
            return;
        }

        const auto answer = answerFromCompletion(upstream.body);
        if (!answer) {
            writeError(response, 502, "invalid_upstream_response",
                       "上游模型返回的响应不符合兼容接口格式。", origin);
            return;
        }

        writeJson(response, 200, Json{
            {"version", 1},
            {"ok", true},
            {"source", "openai-compatible"},
            {"answer", *answer},
        }, origin);
    });

    std::cout << "agent-proxy listening on http://" << listenHost << ":8787" << std::endl;
    if (!server.listen(listenHost, 8787)) {
        std::cerr << "failed to listen on " << listenHost << ":8787" << std::endl;
        return 1;
    }

    return 0;
}