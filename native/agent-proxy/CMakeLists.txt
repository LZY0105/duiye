cmake_minimum_required(VERSION 3.25)

project(agent_proxy LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

include(FetchContent)

set(HTTPLIB_INSTALL OFF CACHE BOOL "" FORCE)
set(HTTPLIB_USE_OPENSSL_IF_AVAILABLE OFF CACHE BOOL "" FORCE)
set(HTTPLIB_USE_ZLIB_IF_AVAILABLE OFF CACHE BOOL "" FORCE)
set(HTTPLIB_USE_BROTLI_IF_AVAILABLE OFF CACHE BOOL "" FORCE)
set(HTTPLIB_USE_ZSTD_IF_AVAILABLE OFF CACHE BOOL "" FORCE)
set(JSON_BuildTests OFF CACHE BOOL "" FORCE)

FetchContent_Declare(
    httplib
    GIT_REPOSITORY https://github.com/yhirose/cpp-httplib.git
    GIT_TAG v0.51.0
    GIT_SHALLOW TRUE
)

FetchContent_Declare(
    nlohmann_json
    GIT_REPOSITORY https://github.com/nlohmann/json.git
    GIT_TAG v3.12.0
    GIT_SHALLOW TRUE
)

FetchContent_MakeAvailable(httplib nlohmann_json)

add_executable(agent-proxy
    src/main.cpp
    src/upstream_http.cpp
)

target_link_libraries(agent-proxy
    PRIVATE
        httplib::httplib
        nlohmann_json::nlohmann_json
)

if (WIN32)
    target_compile_definitions(agent-proxy
        PRIVATE
            WIN32_LEAN_AND_MEAN
            NOMINMAX
    )

    target_compile_options(agent-proxy
        PRIVATE
            /W4
            /permissive-
            /utf-8
    )

    target_link_libraries(agent-proxy PRIVATE winhttp)
else()
    find_package(CURL REQUIRED)

    target_compile_options(agent-proxy
        PRIVATE
            -Wall
            -Wextra
            -Wpedantic
    )

    target_link_libraries(agent-proxy PRIVATE CURL::libcurl)
endif()