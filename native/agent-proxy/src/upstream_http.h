#pragma once

#include <optional>
#include <string>

namespace duiye::agent {

struct UpstreamResult {
    long status = 0;
    std::string body;
    bool timedOut = false;
    std::string error;
};

std::optional<std::string> completionUrl(std::string baseUrl);

UpstreamResult postJson(
    const std::string& url,
    const std::string& apiKey,
    const std::string& body,
    long timeoutMs
);

} // namespace duiye::agent