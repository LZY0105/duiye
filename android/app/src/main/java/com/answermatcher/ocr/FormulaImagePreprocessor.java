// 从「题目答案匹配引擎」仓库 ocr/android/src/com/answermatcher/ocr/FormulaImagePreprocessor.java 原样拷来（只多这两行注释）。
// 要改请在那边改、在桌面上验过（verify_parity.py / verify_preprocess.py）再拷回来，两份保持一致。
package com.answermatcher.ocr;

/**
 * 与 Pillow 逐位一致的预处理：metadata.json 的 "preprocessing"，即 scratch_model.preprocess_image /
 * recognize_scratch.preprocess_image 那几步。
 *
 * 输入是未预乘的 ARGB 像素（Android 的 Bitmap.getPixels、桌面的 BufferedImage.getRGB 都是这个顺序），
 * 输出是 height × width 个 float32，按行排，值为 像素 / 127.5 - 1，直接交给 ScratchFormulaRecognizer。
 * 每一步都照 Pillow 的整数算法写（透明合成到白底、转灰度、裁外框、LANCZOS 缩放），这样同一张图在
 * 训练时、桌面评估时和设备上得到的张量完全相同；用浮点近似的话，几个灰度级的差别就够让结果变样。
 * 不依赖 Android，桌面上可以直接拿来和 Python 比对（verify_preprocess.py）。
 */
public final class FormulaImagePreprocessor {

    /** 圈里没有任何比白底深的像素：没有东西可认。 */
    public static final class BlankImageException extends IllegalArgumentException {
        BlankImageException() {
            super("Input crop is blank; no formula pixels found");
        }
    }

    /** Pillow Resample.c 的定点精度。 */
    private static final int PRECISION_BITS = 32 - 8 - 2;
    /** Pillow AlphaComposite.c 的定点精度。 */
    private static final int COMPOSITE_PRECISION_BITS = 7;

    private FormulaImagePreprocessor() {}

    /**
     * @param argb   未预乘的 ARGB，长度 width × height
     * @param height 模型输入高（metadata.json 的 input.height）
     * @param width  模型输入宽
     */
    public static float[] preprocess(int[] argb, int imageWidth, int imageHeight, int height, int width) {
        if (height < 16 || width < 16) throw new IllegalArgumentException("Image dimensions must be at least 16 pixels");
        if (imageWidth < 1 || imageHeight < 1 || argb.length != imageWidth * imageHeight) {
            throw new IllegalArgumentException("Pixel count does not match the image size");
        }
        int[] gray = grayOnWhite(argb);

        // 裁外框：与白差大于 10（即灰度小于 245）的像素的外接矩形，右、下为开区间（Pillow getbbox）。
        int left = imageWidth, top = imageHeight, right = -1, bottom = -1;
        for (int y = 0; y < imageHeight; y++) {
            for (int x = 0; x < imageWidth; x++) {
                if (255 - gray[y * imageWidth + x] > 10) {
                    if (x < left) left = x;
                    if (x > right) right = x;
                    if (y < top) top = y;
                    if (y > bottom) bottom = y;
                }
            }
        }
        if (right < 0) throw new BlankImageException();
        int cropWidth = right - left + 1;
        int cropHeight = bottom - top + 1;
        int[] crop = new int[cropWidth * cropHeight];
        for (int y = 0; y < cropHeight; y++) {
            System.arraycopy(gray, (top + y) * imageWidth + left, crop, y * cropWidth, cropWidth);
        }

        // 保持比例缩进画布、四周留 4 像素；Python 的 round 是逢五取偶，与 Math.rint 相同。
        double scale = Math.min((double) (width - 8) / cropWidth, (double) (height - 8) / cropHeight);
        int scaledWidth = Math.max(1, (int) Math.rint(cropWidth * scale));
        int scaledHeight = Math.max(1, (int) Math.rint(cropHeight * scale));
        int[] scaled = resizeLanczos(crop, cropWidth, cropHeight, scaledWidth, scaledHeight);

        // 白底居中（整数下取整的偏移），再归一化到 [-1, 1]。
        int offsetX = (width - scaledWidth) / 2;
        int offsetY = (height - scaledHeight) / 2;
        float[] out = new float[width * height];
        float white = 255f / 127.5f - 1f;
        java.util.Arrays.fill(out, white);
        for (int y = 0; y < scaledHeight; y++) {
            for (int x = 0; x < scaledWidth; x++) {
                out[(offsetY + y) * width + offsetX + x] = scaled[y * scaledWidth + x] / 127.5f - 1f;
            }
        }
        return out;
    }

    /** 合成到白底（Pillow ImagingAlphaComposite，背景不透明）再转灰度（Pillow rgb2l）。 */
    static int[] grayOnWhite(int[] argb) {
        int[] gray = new int[argb.length];
        for (int i = 0; i < argb.length; i++) {
            int pixel = argb[i];
            int a = pixel >>> 24;
            int r = (pixel >>> 16) & 255;
            int g = (pixel >>> 8) & 255;
            int b = pixel & 255;
            if (a == 0) {
                r = g = b = 255;
            } else {
                long blend = 255L * (255 - a);
                long outa255 = a * 255L + blend;
                long coef1 = a * 255L * 255L * (1L << COMPOSITE_PRECISION_BITS) / outa255;
                long coef2 = 255L * (1L << COMPOSITE_PRECISION_BITS) - coef1;
                r = composite(r, coef1, coef2);
                g = composite(g, coef1, coef2);
                b = composite(b, coef1, coef2);
            }
            gray[i] = (r * 19595 + g * 38470 + b * 7471 + 0x8000) >> 16;
        }
        return gray;
    }

    private static int composite(int source, long coef1, long coef2) {
        long tmp = source * coef1 + 255L * coef2 + (0x80L << COMPOSITE_PRECISION_BITS);
        return (int) ((((tmp >> 8) + tmp) >> 8) >> COMPOSITE_PRECISION_BITS);
    }

    /** Pillow Image.resize(size, LANCZOS)：先横后竖两遍，8 位定点。 */
    static int[] resizeLanczos(int[] source, int sourceWidth, int sourceHeight, int width, int height) {
        if (width == sourceWidth && height == sourceHeight) return source.clone();
        Coefficients horizontal = coefficients(sourceWidth, width);
        Coefficients vertical = coefficients(sourceHeight, height);
        boolean needHorizontal = width != sourceWidth;
        boolean needVertical = height != sourceHeight;

        int[] image = source;
        int imageWidth = sourceWidth;
        int imageHeight = sourceHeight;
        if (needHorizontal) {
            // 只算竖向那一遍要用到的行，竖向的边界相应平移（Pillow ImagingResampleInner）。
            int firstRow = vertical.bounds[0];
            int lastRow = vertical.bounds[(height - 1) * 2] + vertical.bounds[(height - 1) * 2 + 1];
            for (int i = 0; i < height; i++) vertical.bounds[i * 2] -= firstRow;
            int rows = lastRow - firstRow;
            int[] temp = new int[width * rows];
            for (int y = 0; y < rows; y++) {
                int rowStart = (y + firstRow) * sourceWidth;
                for (int x = 0; x < width; x++) {
                    int min = horizontal.bounds[x * 2];
                    int count = horizontal.bounds[x * 2 + 1];
                    int k = x * horizontal.size;
                    int sum = 1 << (PRECISION_BITS - 1);
                    for (int i = 0; i < count; i++) sum += source[rowStart + min + i] * horizontal.weights[k + i];
                    temp[y * width + x] = clip8(sum);
                }
            }
            image = temp;
            imageWidth = width;
            imageHeight = rows;
        }
        if (!needVertical) return image;
        int[] out = new int[imageWidth * height];
        for (int y = 0; y < height; y++) {
            int min = vertical.bounds[y * 2];
            int count = vertical.bounds[y * 2 + 1];
            int k = y * vertical.size;
            for (int x = 0; x < imageWidth; x++) {
                int sum = 1 << (PRECISION_BITS - 1);
                for (int i = 0; i < count; i++) sum += image[(min + i) * imageWidth + x] * vertical.weights[k + i];
                out[y * imageWidth + x] = clip8(sum);
            }
        }
        return out;
    }

    private static int clip8(int value) {
        int shifted = value >> PRECISION_BITS;
        return shifted < 0 ? 0 : Math.min(shifted, 255);
    }

    private static final class Coefficients {
        final int size;
        final int[] bounds;
        final int[] weights;

        Coefficients(int size, int[] bounds, int[] weights) {
            this.size = size;
            this.bounds = bounds;
            this.weights = weights;
        }
    }

    /** Pillow precompute_coeffs + normalize_coeffs_8bpc；缩放框为整张图（0, 0, 宽, 高）。 */
    private static Coefficients coefficients(int inSize, int outSize) {
        double scale = (double) ((float) inSize - 0f) / outSize;
        double filterScale = Math.max(scale, 1.0);
        double support = 3.0 * filterScale;
        int size = (int) Math.ceil(support) * 2 + 1;
        int[] bounds = new int[outSize * 2];
        int[] weights = new int[outSize * size];
        double[] k = new double[size];
        for (int xx = 0; xx < outSize; xx++) {
            double center = (xx + 0.5) * scale;
            double ss = 1.0 / filterScale;
            int min = (int) (center - support + 0.5);
            if (min < 0) min = 0;
            int max = (int) (center + support + 0.5);
            if (max > inSize) max = inSize;
            max -= min;
            double total = 0.0;
            for (int x = 0; x < max; x++) {
                double w = lanczos((x + min - center + 0.5) * ss);
                k[x] = w;
                total += w;
            }
            for (int x = 0; x < size; x++) {
                double w = x < max ? (total != 0.0 ? k[x] / total : k[x]) : 0.0;
                weights[xx * size + x] = w < 0 ? (int) (-0.5 + w * (1 << PRECISION_BITS))
                                               : (int) (0.5 + w * (1 << PRECISION_BITS));
            }
            bounds[xx * 2] = min;
            bounds[xx * 2 + 1] = max;
        }
        return new Coefficients(size, bounds, weights);
    }

    private static double lanczos(double x) {
        return -3.0 <= x && x < 3.0 ? sinc(x) * sinc(x / 3) : 0.0;
    }

    private static double sinc(double x) {
        if (x == 0.0) return 1.0;
        x = x * Math.PI;
        return StrictMath.sin(x) / x;
    }
}
