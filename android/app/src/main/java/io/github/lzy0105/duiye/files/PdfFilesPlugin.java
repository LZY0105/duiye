package io.github.lzy0105.duiye.files;

import android.content.Intent;
import android.database.Cursor;
import android.media.MediaScannerConnection;
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
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

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
 * 读之外只做一件写的事：把「导出 PDF」做出来的文件**新建**在「文档/对页」里
 * （beginExport 那一组）。插件没有任何删除或修改人自己文件的方法——权限给的范围比
 * 用得着的大，那是 Android 的粒度问题，不是可以顺手多做几件事的理由。
 */
@CapacitorPlugin(name = "PdfFiles")
public class PdfFilesPlugin extends Plugin {

    /** 一次最多回多少条。三千本 PDF 的机器是有的，一次全塞进 WebView 不合适。 */
    private static final int LIMIT = 2000;

    /** 导出的文件放在公共「文档」目录下的这个文件夹里。 */
    private static final String EXPORT_FOLDER = "对页";

    /** 正在写的导出：凭据 → 临时文件，凭据 → 想要的文件名。 */
    private final Map<String, File> exports = new HashMap<>();
    private final Map<String, String> exportNames = new HashMap<>();

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

    // ── 导出 ────────────────────────────────────────────────────────────────

    /**
     * 开始写一份导出的 PDF，回一个凭据。
     *
     * 写的是一个隐藏的临时文件（点开头，list() 和系统的文件管理器都不列它），全部写
     * 完、finishExport 时才改成真名字。写到一半断了，文件夹里不会多出一份打不开的
     * 半截 PDF。
     *
     * 没有「所有文件访问权限」就拒绝：网页那边在导出前已经问过，走到这里还没有，说明
     * 人在这期间把它关了——照实说，让那边再问一次。
     */
    @PluginMethod
    public void beginExport(PluginCall call) {
        if (!granted()) {
            call.reject("NO_PERMISSION", "all-files access has not been granted");
            return;
        }
        String name = safeName(call.getString("name"));
        File dir = exportDir();
        if (!dir.isDirectory() && !dir.mkdirs()) {
            call.reject("WRITE_FAILED", "could not create " + dir.getAbsolutePath());
            return;
        }
        String token = UUID.randomUUID().toString();
        File temp = new File(dir, "." + token + ".part");
        try {
            if (!temp.createNewFile()) {
                call.reject("WRITE_FAILED", "could not create " + temp.getAbsolutePath());
                return;
            }
        } catch (Exception e) {
            call.reject("WRITE_FAILED", e.getMessage());
            return;
        }
        synchronized (exports) {
            exports.put(token, temp);
            exportNames.put(token, name);
        }
        JSObject result = new JSObject();
        result.put("token", token);
        call.resolve(result);
    }

    /** 接着写一块。base64 是因为桥只走 JSON；一块只有几兆，解码不会把内存撑起来。 */
    @PluginMethod
    public void appendExport(PluginCall call) {
        String token = call.getString("token");
        String data = call.getString("data");
        File temp;
        synchronized (exports) {
            temp = token == null ? null : exports.get(token);
        }
        if (temp == null || data == null) {
            call.reject("BAD_REQUEST", "unknown export");
            return;
        }
        try (FileOutputStream out = new FileOutputStream(temp, true)) {
            out.write(Base64.decode(data, Base64.DEFAULT));
        } catch (Exception e) {
            call.reject("WRITE_FAILED", e.getMessage());
            return;
        }
        call.resolve();
    }

    /**
     * 写完了：改成真名字，并告诉媒体库有这么一份新文件。
     *
     * 不告诉媒体库的话，别的应用（文件管理、微信、WPS）要等系统哪天自己扫到才看得见
     * 它，本应用自己的「本机 PDF」单子也一样——人刚导出的东西在哪儿都找不到。
     */
    @PluginMethod
    public void finishExport(PluginCall call) {
        String token = call.getString("token");
        File temp;
        String name;
        synchronized (exports) {
            temp = token == null ? null : exports.remove(token);
            name = token == null ? null : exportNames.remove(token);
        }
        if (temp == null) {
            call.reject("BAD_REQUEST", "unknown export");
            return;
        }
        File target = uniqueFile(temp.getParentFile(), name);
        if (!temp.renameTo(target)) {
            //noinspection ResultOfMethodCallIgnored
            temp.delete();
            call.reject("WRITE_FAILED", "could not rename to " + target.getAbsolutePath());
            return;
        }
        MediaScannerConnection.scanFile(getContext(),
            new String[] { target.getAbsolutePath() }, new String[] { "application/pdf" }, null);
        JSObject result = new JSObject();
        result.put("name", target.getName());
        result.put("folder", Environment.DIRECTORY_DOCUMENTS + "/" + EXPORT_FOLDER);
        result.put("path", target.getAbsolutePath());
        call.resolve(result);
    }

    /** 放弃这一份：删掉临时文件。 */
    @PluginMethod
    public void abortExport(PluginCall call) {
        String token = call.getString("token");
        File temp;
        synchronized (exports) {
            temp = token == null ? null : exports.remove(token);
            if (token != null) exportNames.remove(token);
        }
        //noinspection ResultOfMethodCallIgnored
        if (temp != null) temp.delete();
        call.resolve();
    }

    private static File exportDir() {
        File documents = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS);
        return new File(documents, EXPORT_FOLDER);
    }

    /**
     * 文件系统不认的字符换成空格，开头的点去掉（那会变成隐藏文件），没有 .pdf 就补上。
     * 网页那边已经洗过一遍名字，这里是给文件系统的保证，不是信任那一边。
     */
    private static String safeName(String name) {
        String clean = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]", " ").trim();
        while (clean.startsWith(".")) clean = clean.substring(1).trim();
        if (clean.isEmpty()) clean = "Duiye.pdf";
        if (!clean.toLowerCase().endsWith(".pdf")) clean = clean + ".pdf";
        return clean;
    }

    /** 重名就加「 (2)」「 (3)」……绝不覆盖一份已经在那儿的文件。 */
    private static File uniqueFile(File dir, String name) {
        String safe = safeName(name);
        File file = new File(dir, safe);
        if (!file.exists()) return file;
        String base = safe.substring(0, safe.length() - 4);
        for (int i = 2; i < 1000; i++) {
            File next = new File(dir, base + " (" + i + ").pdf");
            if (!next.exists()) return next;
        }
        return new File(dir, base + " (" + System.currentTimeMillis() + ").pdf");
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
