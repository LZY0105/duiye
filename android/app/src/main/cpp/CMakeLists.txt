# 对页 — 原生代理层。
#
# 现在编出来的这个 .so 里没有任何模型、也没有任何识别引擎：它是一座桥加两个
# 空位。以后接 llama.cpp 或者某个 OCR 引擎，是在这里多加几个源文件、在
# duiye_proxy.cpp 之外多写一个 Service 实现，而不是重新设计这一层。
#
# 之所以现在就把它编进去、而不是留个空目录写着「以后再说」：一份从来没编译过
# 的接口和一份不存在的接口是一回事。它现在真的编、真的装进 APK、JS 真的能问到
# 它并拿到 "ready": false——那才叫预留。

cmake_minimum_required(VERSION 3.22.1)
project(duiye_proxy CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(duiye_proxy SHARED
        duiye_proxy.cpp
        jni_bridge.cpp)

target_include_directories(duiye_proxy PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})

# log 是给实现方用的；桥自己不打日志，它把话都带回 JS 那一侧去说。
find_library(log-lib log)
target_link_libraries(duiye_proxy ${log-lib})
