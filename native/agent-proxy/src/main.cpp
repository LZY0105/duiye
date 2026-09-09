#include <iostream>
#include <string>

#include <httplib.h>
#include <nlohmann/json.hpp>

namespace {

using Json = nlohmann::json;

void writeCorsHeaders(httplib::Response& response) {
    response.set_header("Access-Control-Allow-Origin", "*");
    response.set_header(
        "Access-Control-Allow-Methods",
        "GET, POST, OPTIONS"
    );
    response.set_header(
        "Access-Control-Allow-Headers",
        "Content-Type"
    );
    response.set_header("Access-Control-Max-Age", "600");
}

void writeJson(
    httplib::Response& response,
    int status,
    const Json& body
) {
    writeCorsHeaders(response);
    response.status = status;
    response.set_header("Cache-Control", "no-store");
    response.set_content(
        body.dump(),
        "application/json; charset=utf-8"
    );
}

void writeError(
    httplib::Response& response,
    int status,
    const std::string& code,
    const std::string& message
) {
    writeJson(
        response,
        status,
        Json{
            {"version", 1},
            {"ok", false},
            {"error", code},
            {"message", message}
        }
    );
}

bool isJsonRequest(const httplib::Request& request) {
    if (!request.has_header("Content-Type")) {
        return false;
    }

    const auto contentType =
        request.get_header_value("Content-Type");

    return contentType.rfind("application/json", 0) == 0;
}

} // namespace

int main() {
    httplib::Server server;

    // Limit the request payload to 64 KiB.
    server.set_payload_max_length(64 * 1024);

    server.Options(
        "/health",
        [](const httplib::Request&, httplib::Response& response) {
            writeCorsHeaders(response);
            response.status = 204;
        }
    );

    server.Options(
        "/v1/agent/answer",
        [](const httplib::Request&, httplib::Response& response) {
            writeCorsHeaders(response);
            response.status = 204;
        }
    );

    server.Get(
        "/health",
        [](const httplib::Request&, httplib::Response& response) {
            writeJson(
                response,
                200,
                Json{
                    {"version", 1},
                    {"ok", true},
                    {"service", "agent-proxy"}
                }
            );
        }
    );

    server.Post(
        "/v1/agent/answer",
        [](const httplib::Request& request,
           httplib::Response& response) {
            if (!isJsonRequest(request)) {
                writeError(
                    response,
                    415,
                    "unsupported_content_type",
                    "Content-Type must be application/json"
                );
                return;
            }

            Json payload;

            try {
                payload = Json::parse(request.body);
            } catch (const Json::exception&) {
                writeError(
                    response,
                    400,
                    "invalid_json",
                    "Request body is not valid JSON"
                );
                return;
            }

            if (!payload.contains("version") ||
                !payload["version"].is_number_integer()) {
                writeError(
                    response,
                    400,
                    "invalid_version",
                    "version must be an integer"
                );
                return;
            }

            if (payload["version"].get<long long>() != 1) {
                writeError(
                    response,
                    400,
                    "unsupported_version",
                    "Only version 1 is supported"
                );
                return;
            }

            if (!payload.contains("page") ||
                !payload["page"].is_number_integer()) {
                writeError(
                    response,
                    400,
                    "invalid_page",
                    "page must be an integer"
                );
                return;
            }

            const auto page = payload["page"].get<long long>();

            if (page < 1 || page > 100000) {
                writeError(
                    response,
                    400,
                    "invalid_page",
                    "page must be between 1 and 100000"
                );
                return;
            }

            if (!payload.contains("questionText") ||
                !payload["questionText"].is_string()) {
                writeError(
                    response,
                    400,
                    "invalid_question_text",
                    "questionText must be a string"
                );
                return;
            }

            const auto questionText =
                payload["questionText"].get<std::string>();

            if (questionText.empty() ||
                questionText.size() > 32768) {
                writeError(
                    response,
                    400,
                    "invalid_question_text",
                    "questionText must contain 1 to 32768 characters"
                );
                return;
            }

            if (!payload.contains("textOrigin") ||
                !payload["textOrigin"].is_string()) {
                writeError(
                    response,
                    400,
                    "invalid_text_origin",
                    "textOrigin must be a string"
                );
                return;
            }

            const auto textOrigin =
                payload["textOrigin"].get<std::string>();

            if (textOrigin.empty() || textOrigin.size() > 32) {
                writeError(
                    response,
                    400,
                    "invalid_text_origin",
                    "textOrigin must contain 1 to 32 characters"
                );
                return;
            }

            // Return a deterministic local mock result for now.
            // Do not call an external model or log questionText.
            const auto answer =
                std::string("C++ local proxy mock received page ") +
                std::to_string(page) +
                " text from " +
                textOrigin +
                ".";

            writeJson(
                response,
                200,
                Json{
                    {"version", 1},
                    {"ok", true},
                    {"source", "cpp-mock"},
                    {"answer", answer}
                }
            );
        }
    );

    std::cout
        << "agent-proxy listening on "
        << "http://127.0.0.1:8787"
        << std::endl;

    if (!server.listen("127.0.0.1", 8787)) {
        std::cerr
            << "failed to listen on 127.0.0.1:8787"
            << std::endl;
        return 1;
    }

    return 0;
}