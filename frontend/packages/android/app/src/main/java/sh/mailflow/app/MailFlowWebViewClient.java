package sh.mailflow.app;

import android.content.Context;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

public class MailFlowWebViewClient extends BridgeWebViewClient {
    private static final String FALLBACK_URL = "file:///android_asset/public/host-unavailable.html";
    private final Context context;
    private boolean loadingFallback = false;

    public MailFlowWebViewClient(Bridge bridge, Context context) {
        super(bridge);
        this.context = context.getApplicationContext();
    }

    @Override
    public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
        super.onReceivedHttpError(view, request, errorResponse);

        if (!request.isForMainFrame() || errorResponse == null) return;
        int statusCode = errorResponse.getStatusCode();
        if ((statusCode == 404 || statusCode == 502 || statusCode == 503 || statusCode == 504) && isConfiguredHost(request.getUrl().toString())) {
            loadFallback(view);
        }
    }

    @Override
    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        super.onReceivedError(view, request, error);

        if (request.isForMainFrame() && isConfiguredHost(request.getUrl().toString())) {
            loadFallback(view);
        }
    }

    @Override
    public void onPageFinished(WebView view, String url) {
        super.onPageFinished(view, url);

        if (FALLBACK_URL.equals(url)) return;
        loadingFallback = false;

        if (!isConfiguredHost(url)) return;

        MailFlowNativePlugin.injectCapacitorCompat(view);
        MailFlowNativePlugin.injectPendingActions(view, context);

        view.evaluateJavascript("(document.body ? document.body.innerText : '')", (text) -> {
            String bodyText = text == null ? "" : text.toLowerCase();
            if (bodyText.contains("rewrite 502 bad gateway page") || bodyText.contains("rewrite 404 error page")) {
                loadFallback(view);
            }
        });
    }

    private boolean isConfiguredHost(String url) {
        String host = MailFlowNativePlugin.getSavedHost(context);
        return host != null && url != null && url.startsWith(host);
    }

    private void loadFallback(WebView view) {
        if (loadingFallback) return;
        loadingFallback = true;
        view.post(() -> view.loadUrl(FALLBACK_URL));
    }
}
