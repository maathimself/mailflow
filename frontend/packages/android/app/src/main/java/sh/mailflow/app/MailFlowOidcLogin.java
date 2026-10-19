package sh.mailflow.app;

import android.app.Dialog;
import android.graphics.Bitmap;
import android.net.Uri;
import android.net.http.SslError;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import androidx.lifecycle.DefaultLifecycleObserver;
import androidx.lifecycle.LifecycleOwner;
import java.net.URI;
import java.util.function.Consumer;

final class MailFlowOidcLogin {
    private MailFlowOidcLogin() {}

    static boolean isStartUrl(String host, String url) {
        return configuredPath(host, url).matches("/auth/oidc/[^/]+/start");
    }

    static boolean isReturnUrl(String host, String url) {
        String path = configuredPath(host, url);
        if (path.matches("/auth/oidc/[^/]+/callback")) return true;
        if (!"/".equals(path) && !"/login".equals(path)) return false;
        String[] query = url.split("#", 2)[0].split("\\?", 2);
        return query.length == 2 && query[1].matches("(^|.*&)(oidc_error|oidc_success)=.*");
    }

    private static String configuredPath(String host, String url) {
        String navigation = navigationUrl(url);
        if (!NativeSecurity.isSameOrigin(host, navigation)) return "";
        try {
            return new URI(navigation).getRawPath();
        } catch (Exception ignored) {
            return "";
        }
    }

    static boolean isAllowedUrl(String host, String url) {
        return NativeSecurity.isSameOrigin(host, navigationUrl(url)) || NativeSecurity.isHttpsUrl(navigationUrl(url));
    }

    // WebView accepts query characters that java.net.URI rejects.
    private static String navigationUrl(String url) {
        return url == null ? "" : url.split("[?#]", 2)[0];
    }

    static boolean isLogoutReturnUrl(String host, String url) {
        return "/login".equals(configuredPath(host, url));
    }

    static void open(MainActivity activity, WebView appView, String host, String startUrl) {
        open(activity, appView, host, startUrl, false);
    }

    static void open(MainActivity activity, WebView appView, String host, String startUrl, boolean logout) {
        Dialog dialog = new Dialog(activity);
        LinearLayout content = new LinearLayout(activity);
        content.setOrientation(LinearLayout.VERTICAL);
        TextView address = new TextView(activity);
        int padding = (int) (16 * activity.getResources().getDisplayMetrics().density);
        address.setPadding(padding, padding, padding, padding);
        content.addView(address);

        // Share the app's cookie jar without exposing its Capacitor or native message bridges.
        WebView loginView = new WebView(activity);
        content.addView(loginView, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        WebSettings settings = loginView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        CookieManager.getInstance().setAcceptThirdPartyCookies(loginView, false);

        String errorPath = logout || !"link".equals(Uri.parse(startUrl).getQueryParameter("action")) ? "/login" : "/";
        Consumer<String> fail = message -> {
            if (!dialog.isShowing()) return;
            dialog.dismiss();
            appView.loadUrl(Uri.parse(host).buildUpon().path(errorPath).appendQueryParameter("oidc_error", message).build().toString());
        };
        loginView.setWebViewClient(new WebViewClient() {
            private String mainFrameUrl = startUrl;

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                mainFrameUrl = url;
                Uri page = Uri.parse(url);
                address.setText(new Uri.Builder().scheme(page.getScheme())
                    .encodedAuthority(page.getHost() + (page.getPort() == -1 ? "" : ":" + page.getPort())).build().toString());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!dialog.isShowing()) return true;
                String url = request.getUrl().toString();
                if (!isAllowedUrl(host, url)) {
                    if (request.isForMainFrame()) {
                        if ("http".equalsIgnoreCase(request.getUrl().getScheme())) {
                            fail.accept("OIDC requires HTTPS for " + request.getUrl().getHost());
                        } else {
                            Toast.makeText(activity, "This sign-in step requires an unsupported link: " + request.getUrl().getScheme(), Toast.LENGTH_LONG).show();
                        }
                    }
                    return true;
                }
                if (request.isForMainFrame()) mainFrameUrl = url;
                if (!request.isForMainFrame() || !(logout ? isLogoutReturnUrl(host, url) : isReturnUrl(host, url))) return false;

                dialog.dismiss();
                appView.loadUrl(url);
                return true;
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                if (error.getUrl().equals(mainFrameUrl)) {
                    fail.accept("Could not verify the OIDC provider certificate: " + Uri.parse(error.getUrl()).getHost());
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) fail.accept("Could not load the OIDC provider: " + request.getUrl().getHost());
            }
        });
        DefaultLifecycleObserver observer = new DefaultLifecycleObserver() {
            @Override
            public void onDestroy(LifecycleOwner owner) {
                dialog.dismiss();
            }
        };
        activity.getLifecycle().addObserver(observer);
        if (logout) dialog.setOnCancelListener(ignored -> appView.loadUrl(Uri.parse(host).buildUpon().path("/login")
            .appendQueryParameter("oidc_error", "Provider sign-out was cancelled; its session may still be active.").build().toString()));
        dialog.setOnDismissListener(ignored -> {
            activity.getLifecycle().removeObserver(observer);
            loginView.stopLoading();
            content.removeView(loginView);
            loginView.destroy();
        });
        dialog.setContentView(content);
        dialog.show();
        dialog.getWindow().setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        if (isAllowedUrl(host, startUrl)) loginView.loadUrl(startUrl);
        else fail.accept("OIDC requires HTTPS for " + Uri.parse(startUrl).getHost());
    }
}
