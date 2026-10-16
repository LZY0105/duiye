package io.github.lzy0105.duiye.proxy;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.UUID;

/**
 * 网页那一侧够得着原生代理的唯一入口。
 *
 * 四个方法，对应四件事：这层在不在（describe）、交一件活（submit）、把它撤回来
 * （cancel），以及一段一段的结果往哪儿去（proxyEvent 事件）。
 *
 * 中间结果走事件而不是走返回值：一个只在算完才开口的模型，在人这一侧和卡死没有
 * 区别。Capacitor 的 PluginCall 可以设成「不释放」再多次 resolve，但那条路上
 * 取消和错误处理都要另写一套；事件是这件事本来的形状。
 */
@CapacitorPlugin(name = "NativeProxy")
public class NativeProxyPlugin extends Plugin {

    private static final String EVENT = "proxyEvent";

    /** ocr 那一位由 Java 接管（见 FormulaOcrService）；C++ 那边的同名空位在 describe 里被它顶替。 */
    private FormulaOcrService ocr;

    @Override
    public void load() {
        ocr = new FormulaOcrService(getContext());
    }

    @Override
    protected void handleOnDestroy() {
        if (ocr != null) ocr.close();
    }

    @PluginMethod
    public void describe(PluginCall call) {
        JSObject result = new JSObject();
        // 带着模型的构建里，就算 C++ 那个库没装上，这一层也算「在」：ocr 那一位是 Java 的。
        result.put("loaded", NativeProxy.available() || ocr.packaged());
        result.put("services", withJavaServices(NativeProxy.describe()));
        call.resolve(result);
    }

    /** 把 C++ 报上来的那份清单里的 ocr 空位换成 Java 这一位。清单形状不对就原样交回去。 */
    private String withJavaServices(String nativeDescription) {
        try {
            JSONObject root = new JSONObject(nativeDescription);
            JSONArray services = root.optJSONArray("services");
            JSONArray merged = new JSONArray();
            if (services != null) {
                for (int i = 0; i < services.length(); i++) {
                    JSONObject entry = services.optJSONObject(i);
                    if (entry != null && !FormulaOcrService.NAME.equals(entry.optString("name"))) merged.put(entry);
                }
            }
            merged.put(ocr.describe());
            root.put("services", merged);
            return root.toString();
        } catch (JSONException malformed) {
            return nativeDescription;
        }
    }

    @PluginMethod
    public void submit(PluginCall call) {
        String service = call.getString("service");
        if (service == null || service.isEmpty()) {
            call.reject("BAD_REQUEST", "service is required");
            return;
        }
        String op = call.getString("op", "");
        JSObject payload = call.getObject("payload", new JSObject());
        // 网页那一侧可以同时有好几个地方在提交，而这里是唯一的汇合点——所以
        // 重号在这里拦（见下面 submit 的返回值）。网页没给编号时这里补一个。
        String requestId = call.getString("requestId");
        if (requestId == null || requestId.isEmpty()) {
            requestId = UUID.randomUUID().toString();
        }

        final String id = requestId;
        NativeProxy.EventSink sink = (rid, kind, json) -> {
            JSObject event = new JSObject();
            event.put("requestId", rid);
            event.put("kind", kind);
            event.put("data", json);
            notifyListeners(EVENT, event);
        };
        boolean accepted = FormulaOcrService.NAME.equals(service)
                ? ocr.submit(op, payload.toString(), id, sink)
                : NativeProxy.submit(service, op, payload.toString(), id, sink);
        if (!accepted) {
            call.reject("BAD_REQUEST", "requestId " + id + " is already in flight");
            return;
        }

        // 交出去就回，回的是这件活的编号。结果从 proxyEvent 上来。
        JSObject result = new JSObject();
        result.put("requestId", id);
        call.resolve(result);
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String requestId = call.getString("requestId");
        if (requestId == null || requestId.isEmpty()) {
            call.reject("BAD_REQUEST", "requestId is required");
            return;
        }
        String service = call.getString("service", "");
        if (FormulaOcrService.NAME.equals(service)) ocr.cancel(requestId);
        else NativeProxy.cancel(service, requestId);
        call.resolve();
    }
}
