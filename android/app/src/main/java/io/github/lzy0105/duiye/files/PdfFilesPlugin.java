package io.github.lzy0105.duiye.files;

import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/**
 * 本机上所有的 PDF，交给网页那一侧去列。
 *
 * 为什么必须有这么一个原生插件：网页里的 &lt;input type="file"&gt; 只能把人交给
 * 系统选择器——那是系统的样子，而且要人自己一层层翻目录。要做成「一张单子列出全
 * 机的 PDF」，只能查 MediaStore，而那是 Android 的 API，网页够不着。
 *
 * 为什么必须要「所有文件访问权限」：PDF 在 MediaStore 眼里不是媒体文件。从
 * Android 11 起，没有 MANAGE_EXTERNAL_STORAGE 的应用查 MediaStore.Files 只看得见
 * **自己创建的**那些——别的应用下载的、微信存的、U 盘拷进来的，一个都看不到。这个
 * 权限没有应用内弹窗，只能把人送到系统设置里自己打开，所以下面 request() 做的就
 * 是「打开那一页」，不是「弹一个框」。
 *
 * 这里只读，不写。插件没有任何删除或修改文件的方法——权限给的范围比用得着的大，
 * 那是 Android 的粒度问题，不是可以顺手多做几件事的理由。
 */
@CapacitorPlugin(name = "PdfFiles")
public class PdfFilesPlugin extends Plugin {

    /** 一次最多回多少条。三千本 PDF 的机器是有的，一次全塞进 WebView 不合适。 */
    private static final int LIMIT = 2000;

    /**
     * 有没有那个权限。
     *
     * Android 11 以下没有这个概念，一律算有——那些系统上普通的读权限就够用。
     */
    @PluginMethod
    public void hasPermission(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", granted());
        call.resolve(result);
    }

    /**
     * 把人送到系统设置里那一页。
     *
     * 注意它**不返回结果**：授权发生在另一个应用里，回来时这边只能重新问一次
     * hasPermission。网页那一侧就是这么做的——回到前台再问，而不是在这里等。
     */
    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (granted()) {
            JSObject result = new JSObject();
            result.put("granted", true);
            call.resolve(result);
            return;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            call.reject("UNSUPPORTED", "this Android version has no all-files permission");
            return;
        }
        try {
            Intent intent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION);
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
        } catch (Exception ignored) {
            // 有的定制系统没有「单个应用」那一页，退到总列表去。
            try {
                Intent fallback = new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION);
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(fallback);
            } catch (Exception e) {
                call.reject("NO_SETTINGS_PAGE", e.getMessage());
                return;
            }
        }
        JSObject result = new JSObject();
        result.put("opened", true);
        call.resolve(result);
    }

    /**
     * 全机的 PDF，新的在前。
     *
     * 按 MIME 查而不是按文件名后缀：一份没有 .pdf 后缀的 PDF 照样是 PDF，而一个叫
     * report.pdf 的文本文件不是。MediaStore 的 MIME 是扫描时按内容定的，比后缀可靠。
     *
     * 回的是 content:// 的 uri 而不是路径：有了那个权限之后路径大多也能用，但从
     * SD 卡、U 盘或者别的 provider 来的东西没有可用的文件路径，而 uri 一直都有。
     */
    @PluginMethod
    public void list(PluginCall call) {
        if (!granted()) {
            call.reject("NO_PERMISSION", "all-files access has not been granted");
            return;
        }
        String[] columns = {
            MediaStore.Files.FileColumns._ID,
            MediaStore.Files.FileColumns.DISPLAY_NAME,
            MediaStore.Files.FileColumns.SIZE,
            MediaStore.Files.FileColumns.DATE_MODIFIED,
            MediaStore.Files.FileColumns.RELATIVE_PATH,
        };
        Uri collection = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
            ? MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL)
            : MediaStore.Files.getContentUri("external");

        JSArray files = new JSArray();
        Cursor cursor = null;
        try {
            cursor = getContext().getContentResolver().query(
                collection,
                columns,
                MediaStore.Files.FileColumns.MIME_TYPE + "=?",
                new String[] { "application/pdf" },
                MediaStore.Files.FileColumns.DATE_MODIFIED + " DESC"
            );
            if (cursor != null) {
                int idAt = cursor.getColumnIndexOrThrow(MediaStore.Files.FileColumns._ID);
                int nameAt = cursor.getColumnIndexOrThrow(MediaStore.Files.FileColumns.DISPLAY_NAME);
                int sizeAt = cursor.getColumnIndexOrThrow(MediaStore.Files.FileColumns.SIZE);
                int dateAt = cursor.getColumnIndexOrThrow(MediaStore.Files.FileColumns.DATE_MODIFIED);
                int pathAt = cursor.getColumnIndex(MediaStore.Files.FileColumns.RELATIVE_PATH);
                while (cursor.moveToNext() && files.length() < LIMIT) {
                    String folder = pathAt >= 0 ? cursor.getString(pathAt) : null;
                    String name = cursor.getString(nameAt);
                    if (hidden(folder) || hidden(name)) continue;
                    long id = cursor.getLong(idAt);
                    JSObject row = new JSObject();
                    row.put("uri", Uri.withAppendedPath(collection, String.valueOf(id)).toString());
                    row.put("name", name);
                    row.put("size", cursor.getLong(sizeAt));
                    // MediaStore 记的是秒，JS 那边用毫秒。
                    row.put("modified", cursor.getLong(dateAt) * 1000L);
                    row.put("folder", folder);
                    files.put(row);
                }
            }
        } catch (Exception e) {
            call.reject("QUERY_FAILED", e.getMessage());
            return;
        } finally {
            if (cursor != null) cursor.close();
        }

        JSObject result = new JSObject();
        result.put("files", files);
        call.resolve(result);
    }

    /**
     * 一份 PDF 的字节，base64 编码。
     *
     * base64 是因为 Capacitor 的桥只走 JSON。一份两百兆的教材编码之后是两百七十
     * 兆的字符串，这条路不便宜——但它只在「人选中了这一份」时走一次，而导入本来就
     * 要把整份字节读进 IndexedDB。
     */
    @PluginMethod
    public void read(PluginCall call) {
        String uri = call.getString("uri");
        if (uri == null || uri.isEmpty()) {
            call.reject("BAD_REQUEST", "uri is required");
            return;
        }
        if (!granted()) {
            call.reject("NO_PERMISSION", "all-files access has not been granted");
            return;
        }
        InputStream in = null;
        try {
            in = getContext().getContentResolver().openInputStream(Uri.parse(uri));
            if (in == null) {
                call.reject("NOT_FOUND", "could not open " + uri);
                return;
            }
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
            JSObject result = new JSObject();
            result.put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
            call.resolve(result);
        } catch (Exception e) {
            call.reject("READ_FAILED", e.getMessage());
        } finally {
            try { if (in != null) in.close(); } catch (Exception ignored) { }
        }
    }

    /**
     * 点开头的目录和文件不算数。
     *
     * Android 上这是「隐藏」的约定，系统自己的文件管理器也是这么做的。滤掉的都不是
     * 人的文档，而是缓存和临时文件——这台机器上就有三份 HONOR Docs/.recent/ 里的
     * 「最近查看」副本（和列表里已经有的是同一本书）和一个 .archivetemp 的解压残
     * 留。不滤的话，同一本书会用两个名字出现两次，而人分不出该选哪个。
     */
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
