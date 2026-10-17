// 从「题目答案匹配引擎」仓库 ocr/android/src/com/answermatcher/ocr/ScratchFormulaRecognizer.java 原样拷来（只多这两行注释）。
// 要改请在那边改、在桌面上验过（verify_parity.py / verify_preprocess.py）再拷回来，两份保持一致。
package com.answermatcher.ocr;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtException;
import ai.onnxruntime.OrtSession;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.nio.LongBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.CancellationException;
import java.util.function.BooleanSupplier;

/**
 * Offline runner for this repository's randomly initialized, locally trained formula model.
 * No Android framework dependency; usable from an Android app with ONNX Runtime Android.
 * Owns sessions, not the shared ORT environment. A caller must close this instance.
 */
public final class ScratchFormulaRecognizer implements AutoCloseable {
    public static final class Prediction {
        public final String latex;
        public final List<Integer> tokenIds;
        public final boolean endedWithEos;
        /** Mean full-vocabulary log probability, including EOS when generated. Not accuracy. */
        public final double meanLogProbability;
        public final String modelTrainingStatus;
        public final boolean reviewRequired = true;
        public final List<String> reasonCodes;

        private Prediction(String latex, List<Integer> tokenIds, boolean endedWithEos,
                           double meanLogProbability, String modelTrainingStatus) {
            this.latex = latex;
            this.tokenIds = Collections.unmodifiableList(new ArrayList<>(tokenIds));
            this.endedWithEos = endedWithEos;
            this.meanLogProbability = meanLogProbability;
            this.modelTrainingStatus = modelTrainingStatus;
            List<String> reasons = new ArrayList<>();
            reasons.add("MODEL_NOT_REALWORLD_VALIDATED");
            if (!endedWithEos) reasons.add("NO_EOS");
            if (tokenIds.isEmpty()) reasons.add("EMPTY");
            this.reasonCodes = Collections.unmodifiableList(reasons);
        }
    }

    /** 解码器每步读整段前缀。 */
    static final String ARCHITECTURE = "scratch-formula-ocr-v1";
    /** 解码器每步只读最新一个记号，前文的 K / V 缓存由上一步传回。 */
    static final String CACHED_ARCHITECTURE = "scratch-formula-ocr-v1-kv";

    private final OrtEnvironment environment;
    private final boolean cached;
    private final OrtSession encoder;
    private final OrtSession decoder;
    private final int height;
    private final int width;
    private final int maxTokens;
    private final int bosId;
    private final int eosId;
    private final int padId;
    private final String[] vocabulary;
    private final String trainingStatus;
    private boolean closed;

    public ScratchFormulaRecognizer(File bundleDirectory, int threads) throws IOException, OrtException {
        if (threads < 1) throw new IllegalArgumentException("threads must be positive");
        Properties properties = new Properties();
        try (InputStream source = new FileInputStream(new File(bundleDirectory, "model.properties"))) {
            properties.load(source);
        }
        if (!"1".equals(required(properties, "format_version"))) {
            throw new IOException("Unsupported model bundle format");
        }
        String architecture = required(properties, "architecture");
        if (!ARCHITECTURE.equals(architecture) && !CACHED_ARCHITECTURE.equals(architecture)) {
            throw new IOException("Unexpected model architecture");
        }
        cached = CACHED_ARCHITECTURE.equals(architecture);
        height = positiveInt(properties, "image_height");
        width = positiveInt(properties, "image_width");
        maxTokens = positiveInt(properties, "max_tokens");
        int vocabularySize = positiveInt(properties, "vocab_size");
        bosId = tokenId(properties, "bos_id", vocabularySize);
        eosId = tokenId(properties, "eos_id", vocabularySize);
        padId = tokenId(properties, "pad_id", vocabularySize);
        if (padId != 0 || bosId != 1 || eosId != 2 || vocabularySize < 4) {
            throw new IOException("Expected PAD/BOS/EOS IDs 0/1/2 and formula tokens");
        }
        trainingStatus = required(properties, "training_status");
        vocabulary = new String[vocabularySize];
        for (int i = 0; i < vocabularySize; i++) {
            try {
                vocabulary[i] = new String(Base64.getDecoder().decode(required(properties, "token." + i)),
                                          StandardCharsets.UTF_8);
            } catch (IllegalArgumentException badToken) {
                throw new IOException("Invalid vocabulary token " + i, badToken);
            }
        }
        java.util.Set<String> uniqueTokens = new java.util.HashSet<>();
        for (String token : vocabulary) {
            if (token.isEmpty() || !uniqueTokens.add(token)) {
                throw new IOException("Vocabulary tokens must be nonempty and unique");
            }
        }
        if (!"<pad>".equals(vocabulary[0]) || !"<bos>".equals(vocabulary[1])
            || !"<eos>".equals(vocabulary[2])) {
            throw new IOException("Invalid special vocabulary tokens");
        }
        String tokenizerHash = required(properties, "tokenizer_sha256");
        verifySha256(new File(bundleDirectory, "tokenizer.json"), tokenizerHash);
        if (!canonicalTokenizerHash(vocabulary).equals(tokenizerHash)) {
            throw new IOException("Properties vocabulary differs from tokenizer.json");
        }
        // ORT 格式的包（to_ort_bundle.py，给精简版 ONNX Runtime 用）在属性里写明文件名；没写就是原来的 .onnx
        File encoderFile = new File(bundleDirectory, modelFileName(properties, "encoder_file", "encoder.onnx"));
        File decoderFile = new File(bundleDirectory, modelFileName(properties, "decoder_file", "decoder.onnx"));
        verifySha256(encoderFile, required(properties, "encoder_sha256"));
        verifySha256(decoderFile, required(properties, "decoder_sha256"));
        environment = OrtEnvironment.getEnvironment();
        OrtSession encoderSession = null;
        OrtSession decoderSession = null;
        try (OrtSession.SessionOptions options = new OrtSession.SessionOptions()) {
            options.setIntraOpNumThreads(threads);
            options.setInterOpNumThreads(1);
            encoderSession = environment.createSession(encoderFile.getAbsolutePath(), options);
            decoderSession = environment.createSession(decoderFile.getAbsolutePath(), options);
        } catch (OrtException | RuntimeException problem) {
            if (decoderSession != null) decoderSession.close();
            if (encoderSession != null) encoderSession.close();
            throw problem;
        }
        encoder = encoderSession;
        decoder = decoderSession;
    }

    public int imageHeight() { return height; }
    public int imageWidth() { return width; }
    public int maximumOutputTokens() { return maxTokens; }

    /**
     * The remaining elements must be exactly H * W float32 pixels in row-major NCHW order.
     * Caller preprocessing MUST follow metadata.json; this API performs no resizing.
     * The buffer's position is not mutated. Use a native-order direct buffer for zero-copy input.
     */
    public synchronized Prediction recognize(FloatBuffer image) throws OrtException {
        return recognize(image, maxTokens);
    }

    public synchronized Prediction recognize(FloatBuffer image, int outputTokenLimit) throws OrtException {
        return recognize(image, outputTokenLimit, null);
    }

    /**
     * 同上；cancelled 每生成一个记号前问一次，返回 true 就抛 CancellationException 停下（长式要一百多步）。
     */
    public synchronized Prediction recognize(FloatBuffer image, int outputTokenLimit, BooleanSupplier cancelled)
            throws OrtException {
        if (closed) throw new IllegalStateException("Recognizer is closed");
        if (outputTokenLimit < 1 || outputTokenLimit > maxTokens) {
            throw new IllegalArgumentException("outputTokenLimit must be in [1, " + maxTokens + "]");
        }
        if (image.remaining() != Math.multiplyExact(height, width)) {
            throw new IllegalArgumentException("Expected exactly " + (height * width) + " image values");
        }
        FloatBuffer pixels = image.slice();
        for (int i = 0; i < pixels.remaining(); i++) {
            if (!Float.isFinite(pixels.get(i))) throw new IllegalArgumentException("Non-finite image value");
        }
        List<Integer> output = new ArrayList<>();
        long[] prefix = new long[outputTokenLimit + 1];
        prefix[0] = bosId;
        double logProbabilitySum = 0;
        int generatedSteps = 0;
        boolean endedWithEos = false;
        try (OnnxTensor imageTensor = OnnxTensor.createTensor(
                 environment, pixels, new long[]{1, 1, height, width});
             OrtSession.Result encoded = encoder.run(Collections.singletonMap("images", imageTensor));
             Steps steps = cached ? new CachedSteps(encoded) : new PrefixSteps(encoded)) {
            for (int step = 0; step < outputTokenLimit; step++) {
                if (cancelled != null && cancelled.getAsBoolean()) throw new CancellationException("Recognition cancelled");
                float[] logits = steps.next(prefix, step + 1);
                if (logits.length != vocabulary.length) throw new IllegalStateException("Vocabulary mismatch");
                int best = -1;
                double maximum = Double.NEGATIVE_INFINITY;
                for (int id = 0; id < logits.length; id++) {
                    if (!Float.isFinite(logits[id])) throw new IllegalStateException("Non-finite decoder logits");
                    maximum = Math.max(maximum, logits[id]);
                    if (id != bosId && id != padId && (best < 0 || logits[id] > logits[best])) best = id;
                }
                double exponentialSum = 0;
                for (float logit : logits) exponentialSum += Math.exp(logit - maximum);
                logProbabilitySum += logits[best] - maximum - Math.log(exponentialSum);
                generatedSteps++;
                if (best == eosId) {
                    endedWithEos = true;
                    break;
                }
                output.add(best);
                prefix[step + 1] = best;
            }
        }
        List<String> tokens = new ArrayList<>();
        for (int id : output) tokens.add(vocabulary[id]);
        return new Prediction(detokenize(tokens), output, endedWithEos,
                              logProbabilitySum / generatedSteps, trainingStatus);
    }

    /** 一步一步给出下一个记号的 logits；prefix 的前 length 个是 BOS 加已生成的记号。 */
    private interface Steps extends AutoCloseable {
        float[] next(long[] prefix, int length) throws OrtException;

        @Override void close() throws OrtException;
    }

    /** 不带缓存：每步把整段前缀送进解码器，取最后一个位置。 */
    private final class PrefixSteps implements Steps {
        private final OnnxTensor memory;

        PrefixSteps(OrtSession.Result encoded) {
            memory = (OnnxTensor) encoded.get(0);
        }

        @Override public float[] next(long[] prefix, int length) throws OrtException {
            LongBuffer ids = ByteBuffer.allocateDirect(length * Long.BYTES).order(ByteOrder.nativeOrder()).asLongBuffer();
            ids.put(prefix, 0, length).flip();
            try (OnnxTensor idsTensor = OnnxTensor.createTensor(environment, ids, new long[]{1, length})) {
                Map<String, OnnxTensor> inputs = new HashMap<>();
                inputs.put("memory", memory);
                inputs.put("tokens", idsTensor);
                try (OrtSession.Result decoded = decoder.run(inputs)) {
                    return ((float[][][]) decoded.get(0).getValue())[0][length - 1];
                }
            }
        }

        @Override public void close() {}
    }

    /**
     * 带缓存：每步只送最新一个记号。上一步传回的 present_keys / present_values 就是这一步的 past，
     * 它们属于上一步的 Result，所以那个 Result 要留到这一步跑完才关。
     */
    private final class CachedSteps implements Steps {
        private final OnnxTensor crossKeys;
        private final OnnxTensor crossValues;
        private final OnnxTensor empty;
        private OrtSession.Result previous;

        CachedSteps(OrtSession.Result encoded) throws OrtException {
            crossKeys = (OnnxTensor) encoded.get("cross_keys").orElseThrow(IllegalStateException::new);
            crossValues = (OnnxTensor) encoded.get("cross_values").orElseThrow(IllegalStateException::new);
            long[] shape = crossKeys.getInfo().getShape();
            empty = OnnxTensor.createTensor(environment,
                ByteBuffer.allocateDirect(0).order(ByteOrder.nativeOrder()).asFloatBuffer(),
                new long[]{shape[0], shape[1], 0, shape[3]});
        }

        @Override public float[] next(long[] prefix, int length) throws OrtException {
            OnnxTensor pastKeys = previous == null ? empty : (OnnxTensor) previous.get(1);
            OnnxTensor pastValues = previous == null ? empty : (OnnxTensor) previous.get(2);
            if (pastKeys.getInfo().getShape()[2] != length - 1) throw new IllegalStateException("Decoder cache length mismatch");
            LongBuffer id = ByteBuffer.allocateDirect(Long.BYTES).order(ByteOrder.nativeOrder()).asLongBuffer();
            id.put(prefix[length - 1]).flip();
            try (OnnxTensor token = OnnxTensor.createTensor(environment, id, new long[]{1, 1})) {
                Map<String, OnnxTensor> inputs = new HashMap<>();
                inputs.put("token", token);
                inputs.put("past_keys", pastKeys);
                inputs.put("past_values", pastValues);
                inputs.put("cross_keys", crossKeys);
                inputs.put("cross_values", crossValues);
                OrtSession.Result decoded = decoder.run(inputs);
                if (previous != null) previous.close();
                previous = decoded;
                return ((float[][]) decoded.get(0).getValue())[0];
            }
        }

        @Override public void close() {
            try {
                if (previous != null) previous.close();
            } finally {
                empty.close();
            }
        }
    }

    static String detokenize(List<String> tokens) {
        StringBuilder latex = new StringBuilder();
        String previous = "";
        for (String token : tokens) {
            if (previous.matches("\\\\[A-Za-z]+") && !token.isEmpty()
                && ((token.charAt(0) >= 'A' && token.charAt(0) <= 'Z')
                    || (token.charAt(0) >= 'a' && token.charAt(0) <= 'z'))) {
                latex.append(' ');
            }
            latex.append(token);
            previous = token;
        }
        return latex.toString();
    }

    @Override public synchronized void close() throws OrtException {
        if (!closed) {
            closed = true;
            try { decoder.close(); } finally { encoder.close(); }
        }
    }

    private static String required(Properties properties, String key) throws IOException {
        String value = properties.getProperty(key);
        if (value == null || value.isEmpty()) throw new IOException("Missing bundle property: " + key);
        return value;
    }

    /** 只认包目录里的一个文件名：不许带路径，免得属性被改成指向包外的文件。 */
    private static String modelFileName(Properties properties, String key, String fallback) throws IOException {
        String name = properties.getProperty(key, fallback);
        if (!name.matches("[A-Za-z0-9][A-Za-z0-9._-]*") || !(name.endsWith(".onnx") || name.endsWith(".ort"))) {
            throw new IOException("Invalid model file name: " + key);
        }
        return name;
    }

    private static int positiveInt(Properties properties, String key) throws IOException {
        try {
            int result = Integer.parseInt(required(properties, key));
            if (result < 1) throw new NumberFormatException("not positive");
            return result;
        } catch (NumberFormatException problem) {
            throw new IOException("Invalid positive integer property: " + key, problem);
        }
    }

    private static int tokenId(Properties properties, String key, int vocabularySize) throws IOException {
        try {
            int result = Integer.parseInt(required(properties, key));
            if (result < 0 || result >= vocabularySize) throw new NumberFormatException("outside vocabulary");
            return result;
        } catch (NumberFormatException problem) {
            throw new IOException("Invalid token ID: " + key, problem);
        }
    }

    private static String canonicalTokenizerHash(String[] tokens) throws IOException {
        // Match TeXTokenizer.save(): UTF-8, ensure_ascii=False, indent=2, LF.
        // Comparing this digest and the real JSON file binds both vocabulary views.
        StringBuilder serialized = new StringBuilder("{\n  \"version\": 1,\n  \"tokens\": [\n");
        for (int index = 0; index < tokens.length; index++) {
            serialized.append("    \"");
            String token = tokens[index];
            for (int position = 0; position < token.length(); position++) {
                char c = token.charAt(position);
                switch (c) {
                    case '\\': serialized.append("\\\\"); break;
                    case '"': serialized.append("\\\""); break;
                    case '\b': serialized.append("\\b"); break;
                    case '\f': serialized.append("\\f"); break;
                    case '\n': serialized.append("\\n"); break;
                    case '\r': serialized.append("\\r"); break;
                    case '\t': serialized.append("\\t"); break;
                    default:
                        if (c < 32) serialized.append(String.format("\\u%04x", (int) c));
                        else serialized.append(c);
                }
            }
            serialized.append('"');
            if (index + 1 < tokens.length) serialized.append(',');
            serialized.append('\n');
        }
        serialized.append("  ]\n}\n");
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(
                serialized.toString().getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder();
            for (byte value : digest) hex.append(String.format("%02x", value & 255));
            return hex.toString();
        } catch (NoSuchAlgorithmException problem) {
            throw new IOException("SHA-256 unavailable", problem);
        }
    }

    private static void verifySha256(File file, String expected) throws IOException {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (InputStream stream = new FileInputStream(file)) {
                byte[] bytes = new byte[65536];
                int count;
                while ((count = stream.read(bytes)) != -1) digest.update(bytes, 0, count);
            }
            StringBuilder actual = new StringBuilder();
            for (byte value : digest.digest()) actual.append(String.format("%02x", value & 255));
            if (!actual.toString().equals(expected)) throw new IOException("Model checksum mismatch: " + file.getName());
        } catch (NoSuchAlgorithmException problem) {
            throw new IOException("SHA-256 unavailable", problem);
        }
    }
}
