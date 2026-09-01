package com.latexsnipper.llamaruntime

import android.content.Context
import android.os.Build
import com.arm.aichat.AiChat
import com.arm.aichat.InferenceEngine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout

/** Small Java-facing boundary around the upstream llama.cpp Android example runtime. */
object QuestionLlamaRuntime {
    private const val INITIALIZATION_TIMEOUT_MS = 30_000L
    private val supportedAbis = setOf("arm64-v8a", "x86_64")

    @JvmStatic
    fun isSupportedAbi(): Boolean = Build.SUPPORTED_ABIS.any(supportedAbis::contains)

    @JvmStatic
    @Synchronized
    fun generate(
        context: Context,
        modelPath: String,
        systemPrompt: String,
        userPrompt: String,
        maxTokens: Int,
    ): String = runBlocking {
        require(isSupportedAbi()) { "LLAMA_CPP_UNSUPPORTED_ABI" }
        val engine = AiChat.getInferenceEngine(context.applicationContext)
        prepareEngine(engine)
        try {
            engine.loadModel(modelPath)
            engine.setSystemPrompt(systemPrompt)
            engine.sendUserPrompt(userPrompt, maxTokens)
                .toList()
                .joinToString(separator = "")
        } finally {
            resetEngine(engine)
        }
    }

    private suspend fun prepareEngine(engine: InferenceEngine) {
        when (engine.state.value) {
            is InferenceEngine.State.Initializing,
            is InferenceEngine.State.Uninitialized -> withTimeout(INITIALIZATION_TIMEOUT_MS) {
                val state = engine.state.first {
                    it is InferenceEngine.State.Initialized || it is InferenceEngine.State.Error
                }
                if (state is InferenceEngine.State.Error) throw state.exception
            }
            is InferenceEngine.State.ModelReady,
            is InferenceEngine.State.Error -> engine.cleanUp()
            is InferenceEngine.State.Initialized -> Unit
            else -> error("LLAMA_CPP_BUSY")
        }
    }

    private fun resetEngine(engine: InferenceEngine) {
        try {
            if (engine.state.value is InferenceEngine.State.ModelReady ||
                engine.state.value is InferenceEngine.State.Error
            ) {
                engine.cleanUp()
            }
        } catch (_: Exception) {
            // Preserve the generation failure; the next call re-checks engine state.
        }
    }
}
