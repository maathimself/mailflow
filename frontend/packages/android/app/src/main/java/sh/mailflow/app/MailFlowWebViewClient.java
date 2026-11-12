package sh.mailflow.app;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.net.http.SslError;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import androidx.webkit.WebViewCompat;
import com.getcapacitor.BridgeWebViewClient;

public class MailFlowWebViewClient extends BridgeWebViewClient {
    // Served by Capacitor's local server, not from file://: its "Change host" button needs the
    // Capacitor bridge, which a file:// page does not get.
    private static final String FALLBACK_PATH = "/host-unavailable.html";
    static final String REASON_CERTIFICATE = "certificate";
    static final String REASON_WEBVIEW = "webview";
    // The web app is built with Vite's default target, 'baseline-widely-available' (Chrome 111
    // in Vite 8). An older WebView fails on its syntax and shows a blank page (#776).
    static final int MIN_WEBVIEW_MAJOR = 111;
    private final Bridge bridge;
    private final Context context;
    private final MainActivity activity;
    private boolean loadingFallback = false;

    public MailFlowWebViewClient(Bridge bridge, MainActivity activity) {
        super(bridge);
        this.bridge = bridge;
        this.context = activity.getApplicationContext();
        this.activity = activity;
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        Uri uri = request == null ? null : request.getUrl();
        if (request == null || uri == null) return super.shouldOverrideUrlLoading(view, request);

        String url = uri.toString();
        if (request.isForMainFrame() && openOidcLogin(view, url)) return true;
        if (request.isForMainFrame() && isConfiguredHost(url) && isWebViewTooOld(context)) {
            loadFallback(view, REASON_WEBVIEW);
            return true;
        }
        if (isConfiguredHost(url) || isAppPage(url)) return false;
        if (!request.isForMainFrame()) return isWebUrl(uri);
        if (openExternallyIfNeeded(url)) return true;

        return super.shouldOverrideUrlLoading(view, request);
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, String url) {
        if (openOidcLogin(view, url)) return true;
        if (isConfiguredHost(url) && isWebViewTooOld(context)) {
            loadFallback(view, REASON_WEBVIEW);
            return true;
        }
        if (isConfiguredHost(url) || isAppPage(url)) return false;
        if (openExternallyIfNeeded(url)) {
            return true;
        }

        return super.shouldOverrideUrlLoading(view, url);
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

    // The default cancels silently, which left a host with an untrusted certificate on a blank
    // screen (#776). Still cancelled, but the host's own failures now say why.
    @Override
    public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
        handler.cancel();
        if (error != null && isConfiguredHost(error.getUrl())) {
            loadFallback(view, REASON_CERTIFICATE);
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

        if (isFallback(url)) return;
        loadingFallback = false;

        if (!isConfiguredHost(url)) return;

        MailFlowNativePlugin.injectCapacitorCompat(view, MailFlowNativePlugin.getSavedHost(context));
        MailFlowNativePlugin.injectPendingActions(view, context);

        view.evaluateJavascript("(document.body ? document.body.innerText : '')", (text) -> {
            String bodyText = text == null ? "" : text.toLowerCase();
            if (bodyText.contains("rewrite 502 bad gateway page") || bodyText.contains("rewrite 404 error page")) {
                loadFallback(view);
            }
        });
    }

    private boolean openOidcLogin(WebView view, String url) {
        String host = MailFlowNativePlugin.getSavedHost(context);
        if (!MailFlowOidcLogin.isStartUrl(host, url)) return false;
        MailFlowOidcLogin.open(activity, view, host, url);
        return true;
    }

    private boolean isConfiguredHost(String url) {
        String host = MailFlowNativePlugin.getSavedHost(context);
        return host != null && NativeSecurity.isSameOrigin(host, url);
    }

    // The app's own pages (setup, host unavailable), on Capacitor's local server.
    private boolean isAppPage(String url) {
        String local = bridge.getLocalUrl();
        return local != null && url != null && NativeSecurity.isSameOrigin(local, url);
    }

    private boolean isFallback(String url) {
        return isAppPage(url) && FALLBACK_PATH.equals(Uri.parse(url).getPath());
    }

    private boolean isWebUrl(Uri uri) {
        String scheme = uri == null ? null : uri.getScheme();
        return "http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme);
    }

    private boolean openExternallyIfNeeded(String url) {
        if (url == null || url.trim().isEmpty() || isConfiguredHost(url) || isAppPage(url)) {
            return false;
        }

        Uri uri = Uri.parse(url);
        String scheme = uri.getScheme();
        if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme) && !"mailto".equalsIgnoreCase(scheme)) {
            return false;
        }

        Intent intent = new Intent(Intent.ACTION_VIEW, uri);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

        try {
            context.startActivity(intent);
        } catch (ActivityNotFoundException error) {
            return true;
        }

        return true;
    }

    private void loadFallback(WebView view) {
        loadFallback(view, null);
    }

    void loadFallback(WebView view, String reason) {
        if (loadingFallback) return;
        loadingFallback = true;
        String query = reason == null ? "" : "?reason=" + reason;
        view.post(() -> view.loadUrl(bridge.getLocalUrl() + FALLBACK_PATH + query));
    }

    static boolean isWebViewTooOld(Context context) {
        try {
            PackageInfo webView = WebViewCompat.getCurrentWebViewPackage(context);
            return webView != null && isOlderThanSupported(webView.versionName);
        } catch (Exception ignored) {
            return false;
        }
    }

    // "83.0.4103.106" -> too old. Anything unparseable is given the benefit of the doubt.
    static boolean isOlderThanSupported(String versionName) {
        if (versionName == null) return false;
        String major = versionName.split("\\.", 2)[0].trim();
        if (!major.matches("\\d{1,4}")) return false;
        return Integer.parseInt(major) < MIN_WEBVIEW_MAJOR;
    }
}
