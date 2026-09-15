#include <windows.h>
#include <winhttp.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdlib>
#include <iostream>
#include <optional>
#include <string>
#include <string_view>
#include <utility>

#include <httplib.h>
#include <nlohmann/json.hpp>

namespace {

using Json = nlohmann::json;

constexpr std::size_t kMaxQuestionBytes = 32 * 1024;
constexpr std::size_t kMaxUpstreamResponseBytes = 1024 * 1024;
constexpr DWORD kDefaultTimeoutMs = 60 * 1000;
constexpr char kDefaultOriginLocalhost[] = "http://localhost:5173";
constexpr char kDefaultOriginLoopback[] = "http://127.0.0.1:5173";

struct WinHandle {
    explicit WinHandle(HINTERNET value = nullptr) : value(value) {}
    ~WinHandle() { if (value != nullptr) WinHttpCloseHandle(value); }

    WinHandle(const WinHandle&) = delete;
    WinHandle& operator=(const WinHandle&) = delete;

    HINTERNET value;
};

struct Endpoint {
    std::wstring host;
    INTERNET_PORT port = INTERNET_DEFAULT_HTTPS_PORT;
    std::wstring path;
};

struct UpstreamResult {
    DWORD status = 0;
    std::string body;
    DWORD winError = ERROR_SUCCESS;
};

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
    std::optional<Endpoint> endpoint;
    DWORD timeoutMs = kDefaultTimeoutMs;
};

std::optional<std::string> readEnvironment(const char* name) {
    const DWORD size = GetEnvironmentVariableA(name, nullptr, 0);
    if (size == 0) return std::nullopt;

    std::string value(size, '\0');
    const DWORD written = GetEnvironmentVariableA(name, value.data(), size);
    if (written == 0) return std::nullopt;
    value.resize(written);
    return value;
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

std::wstring utf8ToWide(const std::string& text) {
    if (text.empty()) return {};
    const int length = MultiByteToWideChar(
        CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0);
    if (length <= 0) return {};
    std::wstring out(static_cast<std::size_t>(length), L'\0');
    if (MultiByteToWideChar(
            CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()),
            out.data(), length) <= 0) {
        return {};
    }
    return out;
}

std::string wideToUtf8(const std::wstring& text) {
    if (text.empty()) return {};
    const int length = WideCharToMultiByte(
        CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0,
        nullptr, nullptr);
    if (length <= 0) return {};
    std::string out(static_cast<std::size_t>(length), '\0');
    if (WideCharToMultiByte(
            CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()),
            out.data(), length, nullptr, nullptr) <= 0) {
        return {};
    }
    return out;
}

bool endsWith(const std::wstring& value, const std::wstring& suffix) {
    return value.size() >= suffix.size()
        && value.compare(value.size() - suffix.size(), suffix.size(), suffix) == 0;
}

std::optional<Endpoint> parseEndpoint(std::string baseUrl) {
    baseUrl = trim(std::move(baseUrl));
    const std::wstring url = utf8ToWide(baseUrl);
    if (url.empty()) return std::nullopt;

    URL_COMPONENTS parts{};
    parts.dwStructSize = sizeof(parts);
    parts.dwSchemeLength = static_cast<DWORD>(-1);
    parts.dwHostNameLength = static_cast<DWORD>(-1);
    parts.dwUrlPathLength = static_cast<DWORD>(-1);
    parts.dwExtraInfoLength = static_cast<DWORD>(-1);

    if (!WinHttpCrackUrl(url.c_str(), 0, 0, &parts)) return std::nullopt;
    const std::wstring scheme(parts.lpszScheme, parts.dwSchemeLength);
    if (_wcsicmp(scheme.c_str(), L"https") != 0 || parts.dwHostNameLength == 0) {
        return std::nullopt;
    }
    if (parts.dwExtraInfoLength != 0) return std::nullopt;

    Endpoint endpoint;
    endpoint.host.assign(parts.lpszHostName, parts.dwHostNameLength);
    endpoint.port = parts.nPort;
    if (parts.dwUrlPathLength != 0) {
        endpoint.path.assign(parts.lpszUrlPath, parts.dwUrlPathLength);
    }
    if (endpoint.path.empty()) endpoint.path = L"/";
    while (endpoint.path.size() > 1 && endpoint.path.back() == L'/') {
        endpoint.path.pop_back();
    }
    if (endsWith(endpoint.path, L"/chat/completions")) return endpoint;
    if (endpoint.path == L"/") endpoint.path.clear();
    endpoint.path += L"/chat/completions";
    return endpoint;
}

DWORD readTimeout() {
    const auto value = readEnvironment("DUIYE_AGENT_TIMEOUT_MS");
    if (!value) return kDefaultTimeoutMs;
    char* end = nullptr;
    const unsigned long parsed = std::strtoul(value->c_str(), &end, 10);
    if (end == value->c_str() || *end != '\0' || parsed < 1000 || parsed > 120000) {
        return kDefaultTimeoutMs;
    }
    return static_cast<DWORD>(parsed);
}

AgentConfig readConfig() {
    AgentConfig config;
    config.timeoutMs = readTimeout();

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

    config.endpoint = parseEndpoint(*baseUrl);
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
    if (origin == kDefaultOriginLocalhost || origin == kDefaultOriginLoopback) return true;
    return origin == readEnvironment("DUIYE_AGENT_ALLOWED_ORIGIN").value_or("");
}

std::string requestOrigin(const httplib::Request& request) {
    return request.has_header("Origin") ? request.get_header_value("Origin") : "";
}

void writeCorsHeaders(httplib::Response& response, const std::string& origin) {
    if (origin.empty()) return;
    response.set_header("Access-Control-Allow-Origin", origin);
    response.set_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.set_header("Access-Control-Allow-Headers", "Content-Type");
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

bool authoriseOrigin(const httplib::Request& request, httplib::Response& response) {
    const std::string origin = requestOrigin(request);
    if (isAllowedOrigin(origin)) return true;
    writeError(response, 403, "origin_not_allowed", "此网页来源无权调用本地 Agent 代理。");
    return false;
}

bool isJsonRequest(const httplib::Request& request) {
    if (!request.has_header("Content-Type")) return false;
    return request.get_header_value("Content-Type").rfind("application/json", 0) == 0;
}

UpstreamResult postJson(const Endpoint& endpoint, const std::string& apiKey,
                        const std::string& body, DWORD timeoutMs) {
    UpstreamResult out;
    const std::wstring wideKey = utf8ToWide(apiKey);
    if (wideKey.empty()) {
        out.winError = ERROR_INVALID_DATA;
        return out;
    }

    WinHandle session(WinHttpOpen(L"duiye-agent-proxy/1", WINHTTP_ACCESS_TYPE_NO_PROXY,
                                  WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0));
    if (!session.value) { out.winError = GetLastError(); return out; }
    WinHttpSetTimeouts(session.value, 5000, 5000, timeoutMs, timeoutMs);

    WinHandle connection(WinHttpConnect(session.value, endpoint.host.c_str(), endpoint.port, 0));
    if (!connection.value) { out.winError = GetLastError(); return out; }

    WinHandle request(WinHttpOpenRequest(connection.value, L"POST", endpoint.path.c_str(),
                                         nullptr, WINHTTP_NO_REFERER,
                                         WINHTTP_DEFAULT_ACCEPT_TYPES, WINHTTP_FLAG_SECURE));
    if (!request.value) { out.winError = GetLastError(); return out; }

    const std::wstring headers = L"Content-Type: application/json\r\nAccept: application/json\r\n"
        L"Authorization: Bearer " + wideKey + L"\r\n";
    if (!WinHttpSendRequest(request.value, headers.c_str(), static_cast<DWORD>(headers.size()),
                            const_cast<char*>(body.data()), static_cast<DWORD>(body.size()),
                            static_cast<DWORD>(body.size()), 0)) {
        out.winError = GetLastError();
        return out;
    }
    if (!WinHttpReceiveResponse(request.value, nullptr)) {
        out.winError = GetLastError();
        return out;
    }

    DWORD size = sizeof(out.status);
    if (!WinHttpQueryHeaders(request.value,
                             WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                             WINHTTP_HEADER_NAME_BY_INDEX, &out.status, &size,
                             WINHTTP_NO_HEADER_INDEX)) {
        out.winError = GetLastError();
        return out;
    }

    for (;;) {
        DWORD available = 0;
        if (!WinHttpQueryDataAvailable(request.value, &available)) {
            out.winError = GetLastError();
            return out;
        }
        if (available == 0) break;
        if (out.body.size() + available > kMaxUpstreamResponseBytes) {
            out.winError = ERROR_FILE_TOO_LARGE;
            return out;
        }
        std::string chunk(available, '\0');
        DWORD read = 0;
        if (!WinHttpReadData(request.value, chunk.data(), available, &read)) {
            out.winError = GetLastError();
            return out;
        }
        out.body.append(chunk.data(), read);
    }
    return out;
}

std::optional<std::string> answerFromCompletion(const std::string& body) {
    try {
        const Json payload = Json::parse(body);
        const auto choices = payload.find("choices");
        if (choices == payload.end() || !choices->is_array() || choices->empty()) return std::nullopt;
        const auto message = choices->at(0).find("message");
        if (message == choices->at(0).end() || !message->is_object()) return std::nullopt;
        const auto content = message->find("content");
        if (content == message->end() || !content->is_string()) return std::nullopt;
        const std::string answer = trim(content->get<std::string>());
        return answer.empty() ? std::nullopt : std::optional<std::string>(answer);
    } catch (const Json::exception&) {
        return std::nullopt;
    }
}

Json createCompletionRequest(const Json& payload, const AgentConfig& config) {
    const std::string questionText = payload.at("questionText").get<std::string>();
    const long long page = payload.at("page").get<long long>();
    const std::string origin = payload.at("textOrigin").get<std::string>();

    const std::string userPrompt = "以下是 PDF 第 " + std::to_string(page)
        + " 页提取的文字（来源：" + origin + "）：\n\n" + questionText;
    return Json{
        {"model", config.model},
        {"stream", false},
        {"messages", Json::array({
            {
                {"role", "system"},
                {"content", "你是学习资料助手。只依据用户提供的 PDF 当前页文字回答，使用中文。"
                            "若页面存在唯一明确问题，给出简洁的解题思路；若有多题或信息不足，"
                            "说明不能唯一确定，不得编造页面外事实。"},
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
        const AgentConfig config = readConfig();
        const bool ready = config.mode == AgentMode::Mock || config.mode == AgentMode::Upstream;
        writeJson(response, 200, Json{
            {"version", 1},
            {"ok", true},
            {"service", "agent-proxy"},
            {"ready", ready},
            {"mode", modeName(config.mode)},
        }, requestOrigin(request));
    });

    server.Post("/v1/agent/answer", [](const httplib::Request& request,
                                         httplib::Response& response) {
        if (!authoriseOrigin(request, response)) return;
        const std::string origin = requestOrigin(request);
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

        const AgentConfig config = readConfig();
        if (config.mode == AgentMode::Unconfigured) {
            writeError(response, 503, "upstream_not_configured",
                       "本地 Agent 代理尚未配置上游模型。", origin);
            return;
        }
        if (config.mode == AgentMode::Invalid) {
            writeError(response, 503, "invalid_proxy_configuration",
                       "本地 Agent 代理配置无效。", origin);
            return;
        }
        if (config.mode == AgentMode::Mock) {
            writeJson(response, 200, Json{
                {"version", 1},
                {"ok", true},
                {"source", "cpp-mock"},
                {"answer", "C++ 本地 Agent mock 已收到第 "
                    + std::to_string(payload["page"].get<long long>()) + " 页文本。"},
            }, origin);
            return;
        }

        const Json upstreamRequest = createCompletionRequest(payload, config);
        const UpstreamResult upstream = postJson(*config.endpoint, config.apiKey,
                                                 upstreamRequest.dump(), config.timeoutMs);
        if (upstream.winError != ERROR_SUCCESS) {
            const bool timedOut = upstream.winError == ERROR_WINHTTP_TIMEOUT;
            writeError(response, timedOut ? 504 : 502,
                       timedOut ? "upstream_timeout" : "upstream_unreachable",
                       timedOut ? "上游模型响应超时。" : "无法连接上游模型。", origin);
            return;
        }
        if (upstream.status < 200 || upstream.status >= 300) {
            writeError(response, 502, "upstream_rejected",
                       "上游模型拒绝了请求（HTTP " + std::to_string(upstream.status) + "）。", origin);
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

    std::cout << "agent-proxy listening on http://127.0.0.1:8787" << std::endl;
    if (!server.listen("127.0.0.1", 8787)) {
        std::cerr << "failed to listen on 127.0.0.1:8787" << std::endl;
        return 1;
    }
    return 0;
}