#include "upstream_http.h"

#include <algorithm>
#include <cctype>
#include <limits>
#include <string>
#include <utility>

#ifdef _WIN32
#include <windows.h>
#include <winhttp.h>
#else
#include <curl/curl.h>
#endif

namespace duiye::agent {
namespace {

constexpr std::size_t kMaxUpstreamResponseBytes = 1024 * 1024;

std::string trim(std::string value) {
    const auto first = value.find_first_not_of(" \t\r\n");
    if (first == std::string::npos) return {};
    const auto last = value.find_last_not_of(" \t\r\n");
    return value.substr(first, last - first + 1);
}

bool endsWith(const std::string& value, const std::string& suffix) {
    return value.size() >= suffix.size()
        && value.compare(value.size() - suffix.size(), suffix.size(), suffix) == 0;
}

bool hasHttpsScheme(const std::string& value) {
    constexpr char kScheme[] = "https://";
    if (value.size() < sizeof(kScheme) - 1) return false;

    for (std::size_t index = 0; index < sizeof(kScheme) - 1; ++index) {
        const auto current = static_cast<char>(
            std::tolower(static_cast<unsigned char>(value[index]))
        );
        if (current != kScheme[index]) return false;
    }
    return true;
}

std::optional<std::string> normaliseCompletionUrl(std::string baseUrl) {
    baseUrl = trim(std::move(baseUrl));
    if (!hasHttpsScheme(baseUrl)) return std::nullopt;
    if (baseUrl.find_first_of("?#") != std::string::npos) return std::nullopt;

    while (baseUrl.size() > 8 && baseUrl.back() == '/') {
        baseUrl.pop_back();
    }

    if (!endsWith(baseUrl, "/chat/completions")) {
        baseUrl += "/chat/completions";
    }
    return baseUrl;
}

#ifdef _WIN32

struct WinHandle {
    explicit WinHandle(HINTERNET value = nullptr) : value(value) {}
    ~WinHandle() {
        if (value != nullptr) WinHttpCloseHandle(value);
    }

    WinHandle(const WinHandle&) = delete;
    WinHandle& operator=(const WinHandle&) = delete;

    HINTERNET value;
};

struct WindowsEndpoint {
    std::wstring host;
    INTERNET_PORT port = INTERNET_DEFAULT_HTTPS_PORT;
    std::wstring path;
};

std::wstring utf8ToWide(const std::string& text) {
    if (text.empty()) return {};

    const int length = MultiByteToWideChar(
        CP_UTF8,
        MB_ERR_INVALID_CHARS,
        text.data(),
        static_cast<int>(text.size()),
        nullptr,
        0
    );
    if (length <= 0) return {};

    std::wstring out(static_cast<std::size_t>(length), L'\0');
    if (MultiByteToWideChar(
            CP_UTF8,
            MB_ERR_INVALID_CHARS,
            text.data(),
            static_cast<int>(text.size()),
            out.data(),
            length
        ) <= 0) {
        return {};
    }
    return out;
}

bool parseWindowsEndpoint(const std::string& url, WindowsEndpoint& endpoint) {
    const std::wstring wideUrl = utf8ToWide(url);
    if (wideUrl.empty()) return false;

    URL_COMPONENTS parts{};
    parts.dwStructSize = sizeof(parts);
    parts.dwSchemeLength = static_cast<DWORD>(-1);
    parts.dwHostNameLength = static_cast<DWORD>(-1);
    parts.dwUrlPathLength = static_cast<DWORD>(-1);
    parts.dwExtraInfoLength = static_cast<DWORD>(-1);

    if (!WinHttpCrackUrl(wideUrl.c_str(), 0, 0, &parts)) return false;
    if (parts.dwHostNameLength == 0 || parts.dwExtraInfoLength != 0) return false;

    const std::wstring scheme(parts.lpszScheme, parts.dwSchemeLength);
    if (_wcsicmp(scheme.c_str(), L"https") != 0) return false;

    endpoint.host.assign(parts.lpszHostName, parts.dwHostNameLength);
    endpoint.port = parts.nPort;
    endpoint.path.assign(parts.lpszUrlPath, parts.dwUrlPathLength);
    return !endpoint.path.empty();
}

void setWindowsError(UpstreamResult& result, DWORD error) {
    result.timedOut = error == ERROR_WINHTTP_TIMEOUT;
    result.error = "Windows 上游请求失败（错误码 "
        + std::to_string(static_cast<unsigned long>(error)) + "）。";
}

UpstreamResult postJsonWindows(
    const std::string& url,
    const std::string& apiKey,
    const std::string& body,
    long timeoutMs
) {
    UpstreamResult result;
    WindowsEndpoint endpoint;
    if (!parseWindowsEndpoint(url, endpoint)) {
        result.error = "上游地址无效。";
        return result;
    }

    const std::wstring wideKey = utf8ToWide(apiKey);
    if (wideKey.empty()) {
        result.error = "上游密钥无效。";
        return result;
    }

    WinHandle session(WinHttpOpen(
        L"duiye-agent-proxy/1",
        WINHTTP_ACCESS_TYPE_NO_PROXY,
        WINHTTP_NO_PROXY_NAME,
        WINHTTP_NO_PROXY_BYPASS,
        0
    ));
    if (!session.value) {
        setWindowsError(result, GetLastError());
        return result;
    }

    if (!WinHttpSetTimeouts(
            session.value,
            5000,
            5000,
            static_cast<int>(timeoutMs),
            static_cast<int>(timeoutMs)
        )) {
        setWindowsError(result, GetLastError());
        return result;
    }

    WinHandle connection(WinHttpConnect(
        session.value,
        endpoint.host.c_str(),
        endpoint.port,
        0
    ));
    if (!connection.value) {
        setWindowsError(result, GetLastError());
        return result;
    }

    WinHandle request(WinHttpOpenRequest(
        connection.value,
        L"POST",
        endpoint.path.c_str(),
        nullptr,
        WINHTTP_NO_REFERER,
        WINHTTP_DEFAULT_ACCEPT_TYPES,
        WINHTTP_FLAG_SECURE
    ));
    if (!request.value) {
        setWindowsError(result, GetLastError());
        return result;
    }

    std::wstring headers = L"Content-Type: application/json\r\n";
    headers += L"Accept: application/json\r\n";
    headers += L"Authorization: Bearer ";
    headers += wideKey;
    headers += L"\r\n";

    if (!WinHttpSendRequest(
            request.value,
            headers.c_str(),
            static_cast<DWORD>(headers.size()),
            const_cast<char*>(body.data()),
            static_cast<DWORD>(body.size()),
            static_cast<DWORD>(body.size()),
            0
        )) {
        setWindowsError(result, GetLastError());
        return result;
    }

    if (!WinHttpReceiveResponse(request.value, nullptr)) {
        setWindowsError(result, GetLastError());
        return result;
    }

    DWORD status = 0;
    DWORD statusSize = sizeof(status);
    if (!WinHttpQueryHeaders(
            request.value,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            WINHTTP_HEADER_NAME_BY_INDEX,
            &status,
            &statusSize,
            WINHTTP_NO_HEADER_INDEX
        )) {
        setWindowsError(result, GetLastError());
        return result;
    }
    result.status = static_cast<long>(status);

    for (;;) {
        DWORD available = 0;
        if (!WinHttpQueryDataAvailable(request.value, &available)) {
            setWindowsError(result, GetLastError());
            return result;
        }
        if (available == 0) break;

        if (result.body.size() + available > kMaxUpstreamResponseBytes) {
            result.error = "上游响应过大。";
            return result;
        }

        std::string chunk(available, '\0');
        DWORD read = 0;
        if (!WinHttpReadData(request.value, chunk.data(), available, &read)) {
            setWindowsError(result, GetLastError());
            return result;
        }
        result.body.append(chunk.data(), read);
    }

    return result;
}

#else

CURLcode curlGlobalStatus() {
    static const CURLcode status = curl_global_init(CURL_GLOBAL_DEFAULT);
    return status;
}

bool hasCurlHost(const std::string& url) {
    CURLU* parsed = curl_url();
    if (parsed == nullptr) return false;

    const CURLUcode setResult = curl_url_set(parsed, CURLUPART_URL, url.c_str(), 0);

    char* host = nullptr;
    const CURLUcode hostResult = setResult == CURLUE_OK
        ? curl_url_get(parsed, CURLUPART_HOST, &host, 0)
        : CURLUE_BAD_HANDLE;

    const bool valid = hostResult == CURLUE_OK && host != nullptr && host[0] != '\0';
    if (host != nullptr) curl_free(host);
    curl_url_cleanup(parsed);
    return valid;
}

std::size_t appendCurlResponse(
    char* data,
    std::size_t size,
    std::size_t count,
    void* userData
) {
    auto& result = *static_cast<UpstreamResult*>(userData);

    if (size != 0 && count > std::numeric_limits<std::size_t>::max() / size) {
        result.error = "上游响应过大。";
        return 0;
    }

    const std::size_t bytes = size * count;
    if (bytes > kMaxUpstreamResponseBytes - result.body.size()) {
        result.error = "上游响应过大。";
        return 0;
    }

    result.body.append(data, bytes);
    return bytes;
}

UpstreamResult postJsonLinux(
    const std::string& url,
    const std::string& apiKey,
    const std::string& body,
    long timeoutMs
) {
    UpstreamResult result;
    if (curlGlobalStatus() != CURLE_OK) {
        result.error = "无法初始化 Linux 网络库。";
        return result;
    }

    CURL* handle = curl_easy_init();
    if (handle == nullptr) {
        result.error = "无法创建 Linux 网络请求。";
        return result;
    }

    curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    headers = curl_slist_append(headers, "Accept: application/json");

    const std::string authorization = "Authorization: Bearer " + apiKey;
    headers = curl_slist_append(headers, authorization.c_str());

    if (headers == nullptr) {
        curl_easy_cleanup(handle);
        result.error = "无法设置上游请求头。";
        return result;
    }

    curl_easy_setopt(handle, CURLOPT_URL, url.c_str());
    curl_easy_setopt(handle, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(handle, CURLOPT_POST, 1L);
    curl_easy_setopt(handle, CURLOPT_POSTFIELDS, const_cast<char*>(body.data()));
    curl_easy_setopt(handle, CURLOPT_POSTFIELDSIZE, static_cast<long>(body.size()));
    curl_easy_setopt(handle, CURLOPT_CONNECTTIMEOUT_MS, 5000L);
    curl_easy_setopt(handle, CURLOPT_TIMEOUT_MS, timeoutMs);
    curl_easy_setopt(handle, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(handle, CURLOPT_SSL_VERIFYPEER, 1L);
    curl_easy_setopt(handle, CURLOPT_SSL_VERIFYHOST, 2L);
    curl_easy_setopt(handle, CURLOPT_USERAGENT, "duiye-agent-proxy/1");
    curl_easy_setopt(handle, CURLOPT_WRITEFUNCTION, appendCurlResponse);
    curl_easy_setopt(handle, CURLOPT_WRITEDATA, &result);

    const CURLcode code = curl_easy_perform(handle);
    if (code == CURLE_OK) {
        curl_easy_getinfo(handle, CURLINFO_RESPONSE_CODE, &result.status);
    } else {
        result.timedOut = code == CURLE_OPERATION_TIMEDOUT;
        if (result.error.empty()) {
            result.error = "Linux 上游请求失败：" + std::string(curl_easy_strerror(code));
        }
    }

    curl_slist_free_all(headers);
    curl_easy_cleanup(handle);
    return result;
}

#endif

} // namespace

std::optional<std::string> completionUrl(std::string baseUrl) {
    auto normalised = normaliseCompletionUrl(std::move(baseUrl));
    if (!normalised) return std::nullopt;

#ifdef _WIN32
    WindowsEndpoint endpoint;
    if (!parseWindowsEndpoint(*normalised, endpoint)) return std::nullopt;
#else
    if (curlGlobalStatus() != CURLE_OK || !hasCurlHost(*normalised)) return std::nullopt;
#endif

    return normalised;
}

UpstreamResult postJson(
    const std::string& url,
    const std::string& apiKey,
    const std::string& body,
    long timeoutMs
) {
#ifdef _WIN32
    return postJsonWindows(url, apiKey, body, timeoutMs);
#else
    return postJsonLinux(url, apiKey, body, timeoutMs);
#endif
}

} // namespace duiye::agent