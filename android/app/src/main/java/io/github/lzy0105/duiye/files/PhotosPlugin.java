package io.github.lzy0105.duiye.files;

import android.database.Cursor;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Size;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;

/**
 * 「插入图片」那张单子上的「最近照片」。
 *
 * 相册是 MediaStore，网页够不着：这里只做两件事——列出最近的几张照片（新的在前，截图也算），和给一张照片要一张
 * 缩略图。整张照片的字节不在这里读：和本机 PDF 走同一条路（PdfFilesPlugin 的 openRead / readChunk，或者
 * Capacitor 的本地网址），读的是字节，不在乎是什么文件。
 *
 * 权限用的是导入 PDF 时已经要过的「所有文件访问」：有了它，查 MediaStore 看得见全部照片；没有它，Android 13 以后
 * 只看得见本应用自己存的那几张，等于没有——那就照实说 NO_PERMISSION，网页那边给一颗「去打开」。这里不另要
 * 读照片的权限：一个应用里两套说法，人分不清该开哪一个。
 *
 * 只读。没有任何删除、修改照片的方法。
 */
@CapacitorPlugin(name = "Photos")
public class PhotosPlugin extends Plugin {

    /** 一次最多列多少张。单子上只摆最近的几十张，多了是白过桥。 */
    private static final int MAX_LIMIT = 60;

    /** 缩略图的边最大多少像素，压成 JPEG 时的质量。 */
    private static final int MAX_THUMB = 512;
    private static final int THUMB_QUALITY = 80;

    /**
     * 只列这几种：网页那一侧（WebView 的 createImageBitmap）解得开、PDF 嵌得进去的。
     *
     * 不按「是图片」查：MediaStore 眼里 SVG 也是图片，而这台平板上最新的两百五十多张「图片」全是一个 AI 助手
     * 应用丢在共享存储里的 SVG 图标（Honor/YOYOClaw/…/icons/），最近照片那一格一格全成了它们——缩略图要不到
     * （系统的解码器不认 SVG），点了也放不进来（机上 10-17 撞到的）。HEIC 网页那一侧也解不开，先不列。
     */
    private static final String[] PHOTO_TYPES = {
        "image/jpeg", "image/png", "image/webp", "image/gif", "image/bmp",
    };

    /**
     * 最近的几张照片，新的在前。
     *
     * 回的是 content:// 的 uri：读整张、要缩略图都用它。宽高照 MediaStore 记的（拍的时候竖着拿，记的可能是转之前
     * 的宽高——网页那边不靠它排版，只用来说「多大」）。
     */
    @PluginMethod
    public void recent(PluginCall call) {
        if (!granted()) {
            call.reject("NO_PERMISSION", "all-files access has not been granted");
            return;
        }
        int limit = Math.max(1, Math.min(MAX_LIMIT, call.getInt("limit", 30)));
        Uri collection = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
            ? MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
            : MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
        String[] columns = {
            MediaStore.Images.Media._ID,
            MediaStore.Images.Media.DISPLAY_NAME,
            MediaStore.Images.Media.SIZE,
            MediaStore.Images.Media.WIDTH,
            MediaStore.Images.Media.HEIGHT,
            MediaStore.Images.Media.DATE_ADDED,
            MediaStore.Images.Media.MIME_TYPE,
            MediaStore.Images.Media.RELATIVE_PATH,
        };
        JSArray photos = new JSArray();
        Cursor cursor = null;
        StringBuilder only = new StringBuilder(MediaStore.Images.Media.MIME_TYPE).append(" IN (");
        for (int i = 0; i < PHOTO_TYPES.length; i++) only.append(i == 0 ? "?" : ",?");
        only.append(")");
        try {
            cursor = getContext().getContentResolver().query(
                collection, columns, only.toString(), PHOTO_TYPES, MediaStore.Images.Media.DATE_ADDED + " DESC");
            if (cursor != null) {
                int idAt = cursor.getColumnIndexOrThrow(MediaStore.Images.Media._ID);
                int nameAt = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DISPLAY_NAME);
                int sizeAt = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.SIZE);
                int widthAt = cursor.getColumnIndex(MediaStore.Images.Media.WIDTH);
                int heightAt = cursor.getColumnIndex(MediaStore.Images.Media.HEIGHT);
                int dateAt = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_ADDED);
                int mimeAt = cursor.getColumnIndex(MediaStore.Images.Media.MIME_TYPE);
                int pathAt = cursor.getColumnIndex(MediaStore.Images.Media.RELATIVE_PATH);
                while (cursor.moveToNext() && photos.length() < limit) {
                    String folder = pathAt >= 0 ? cursor.getString(pathAt) : null;
                    String name = cursor.getString(nameAt);
                    // 点开头的目录是缓存、缩略图之类，不是人的照片（和 PdfFilesPlugin 一个规矩）。
                    if (hidden(folder) || hidden(name)) continue;
                    long id = cursor.getLong(idAt);
                    JSObject row = new JSObject();
                    row.put("uri", Uri.withAppendedPath(collection, String.valueOf(id)).toString());
                    row.put("name", name);
                    row.put("size", cursor.getLong(sizeAt));
                    row.put("width", widthAt >= 0 ? cursor.getInt(widthAt) : 0);
                    row.put("height", heightAt >= 0 ? cursor.getInt(heightAt) : 0);
                    row.put("mime", mimeAt >= 0 ? cursor.getString(mimeAt) : "image/jpeg");
                    // MediaStore 记的是秒，JS 那边用毫秒。
                    row.put("modified", cursor.getLong(dateAt) * 1000L);
                    photos.put(row);
                }
            }
        } catch (Exception e) {
            call.reject("QUERY_FAILED", e.getMessage());
            return;
        } finally {
            if (cursor != null) cursor.close();
        }
        JSObject result = new JSObject();
        result.put("photos", photos);
        call.resolve(result);
    }

    /**
     * 一张照片的缩略图：data: 网址（JPEG），长边约 size 像素。
     *
     * 用系统给的缩略图（loadThumbnail，Android 10 起有）：相册早就做好了，不用把一张四千多像素的照片整张解开再缩。
     * 连 OutOfMemoryError 也接住：一张缩略图没要到，格子里留一块灰就是了，不该连累整个应用。
     */
    @PluginMethod
    public void thumbnail(PluginCall call) {
        String uri = call.getString("uri");
        if (uri == null || uri.isEmpty()) {
            call.reject("BAD_REQUEST", "uri is required");
            return;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.reject("UNSUPPORTED", "thumbnails need Android 10");
            return;
        }
        int size = Math.max(64, Math.min(MAX_THUMB, call.getInt("size", 240)));
        Bitmap bitmap = null;
        try {
            try {
                bitmap = getContext().getContentResolver().loadThumbnail(Uri.parse(uri), new Size(size, size), null);
            } catch (Exception systemThumbFailed) {
                // 有的照片相册给不出缩略图（定制系统、刚拷进来还没生成）：自己从原图解一张小的。
                bitmap = decodeSmall(Uri.parse(uri), size);
            }
            if (bitmap == null) throw new IllegalStateException("no thumbnail");
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            bitmap.compress(Bitmap.CompressFormat.JPEG, THUMB_QUALITY, out);
            JSObject result = new JSObject();
            result.put("data", "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
            result.put("width", bitmap.getWidth());
            result.put("height", bitmap.getHeight());
            call.resolve(result);
        } catch (Throwable e) {
            call.reject("THUMBNAIL_FAILED", String.valueOf(e.getMessage()));
        } finally {
            if (bitmap != null) bitmap.recycle();
        }
    }

    /**
     * 从原图解一张长边约 size 的小图：ImageDecoder 按拍的方向转正、解的时候就缩小，不先把整张照片解开。
     */
    private Bitmap decodeSmall(Uri uri, int size) throws java.io.IOException {
        android.graphics.ImageDecoder.Source source =
            android.graphics.ImageDecoder.createSource(getContext().getContentResolver(), uri);
        return android.graphics.ImageDecoder.decodeBitmap(source, (decoder, info, src) -> {
            int w = info.getSize().getWidth();
            int h = info.getSize().getHeight();
            float k = Math.min(1f, (float) size / Math.max(1, Math.max(w, h)));
            decoder.setTargetSize(Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)));
            decoder.setAllocator(android.graphics.ImageDecoder.ALLOCATOR_SOFTWARE);
        });
    }

    private static boolean hidden(String path) {
        if (path == null || path.isEmpty()) return false;
        for (String part : path.split("/")) {
            if (part.startsWith(".")) return true;
        }
        return false;
    }

    private boolean granted() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return true;
        return Environment.isExternalStorageManager();
    }
}
