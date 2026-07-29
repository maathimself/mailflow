package sh.mailflow.app;

import android.content.Context;
import android.webkit.WebView;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.JSObject;
import java.util.Collections;
import org.json.JSONObject;

final class MailFlowNativeMessageBridge {
    private static final String BRIDGE_NAME = "MailFlowAndroid";

    private MailFlowNativeMessageBridge() {}

    static void configure(WebView webView, Context context, String configuredHost) {
        if (webView == null || context == null) return;
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;

        try {
            WebViewCompat.removeWebMessageListener(webView, BRIDGE_NAME);
        } catch (Exception ignored) {}

        if (configuredHost == null) return;

        WebViewCompat.addWebMessageListener(
            webView,
            BRIDGE_NAME,
            Collections.singleton(configuredHost),
            (view, message, sourceOrigin, isMainFrame, replyProxy) -> {
                if (!isMainFrame || sourceOrigin == null) return;
                if (!NativeSecurity.isSameOrigin(configuredHost, sourceOrigin.toString())) return;

                JSObject response = new JSObject();
                try {
                    JSONObject request = new JSONObject(message.getData());
                    response.put("id", request.optString("id", ""));
                    response.put(
                        "result",
                        MailFlowNativePlugin.handleNativeBridgeRequest(
                            context.getApplicationContext(),
                            request.optString("method", ""),
                            request.optJSONObject("args")
                        )
                    );
                } catch (Exception error) {
                    response.put("error", "Native request failed");
                }
                replyProxy.postMessage(response.toString());
            }
        );
    }
}
