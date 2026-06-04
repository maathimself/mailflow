package sh.mailflow.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private String lastHandledIntentKey = null;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(MailFlowNativePlugin.class);
        super.onCreate(savedInstanceState);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                handleAndroidBack();
            }
        });

        if (bridge != null) {
            configureCookies();
            bridge.getWebView().addJavascriptInterface(new MailFlowNativePlugin.NotificationBridge(this), "MailFlowAndroid");
            bridge.setWebViewClient(new MailFlowWebViewClient(bridge, this));
            String savedHost = MailFlowNativePlugin.getSavedHost(this);
            if (savedHost != null) {
                MailFlowBackgroundSync.schedule(this);
                bridge.getWebView().post(() -> bridge.getWebView().loadUrl(savedHost));
            }
        }

        handleNativeIntent(getIntent());
    }

    @Override
    public void onPause() {
        flushCookies();
        super.onPause();
    }

    @Override
    public void onResume() {
        super.onResume();
        MailFlowNativePlugin.resumePendingUpdateInstall();
    }

    @Override
    public void onStop() {
        flushCookies();
        MailFlowBackgroundSync.schedule(this);
        super.onStop();
    }

    @Override
    public void onDestroy() {
        flushCookies();
        super.onDestroy();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleNativeIntent(intent);
    }

    private void handleAndroidBack() {
        if (bridge == null || bridge.getWebView() == null) {
            moveTaskToBack(true);
            return;
        }

        WebView webView = bridge.getWebView();
        webView.evaluateJavascript(
            "(function(){try{"
                + "if(typeof window.__mailflowHandleAndroidBack==='function'){return !!window.__mailflowHandleAndroidBack();}"
                + "}catch(e){}"
                + "return false;"
                + "})()",
            (handled) -> {
                if ("true".equals(handled)) return;

                runOnUiThread(() -> moveTaskToBack(true));
            }
        );
    }

    private void handleNativeIntent(Intent intent) {
        if (intent == null) return;
        if (!markIntentHandled(intent)) return;

        String action = intent.getAction();
        Uri data = intent.getData();

        if (MailFlowNativePlugin.ACTION_OPEN_MESSAGE.equals(action)) {
            MailFlowNativePlugin.sendOpenMessageAction(intent);
            return;
        }

        if (MailFlowNativePlugin.ACTION_REPLY_MESSAGE.equals(action)) {
            MailFlowNativePlugin.sendReplyMessageAction(intent);
            return;
        }

        if (MailFlowNativePlugin.ACTION_DELETE_MESSAGE.equals(action)) {
            MailFlowNativePlugin.sendDeleteMessageAction(intent);
            return;
        }

        if (MailFlowNativePlugin.ACTION_STAR_MESSAGE.equals(action)) {
            MailFlowNativePlugin.sendStarMessageAction(intent);
            return;
        }

        if (MailFlowNativePlugin.ACTION_COMPOSE.equals(action)) {
            MailFlowNativePlugin.sendComposeAction();
            return;
        }

        if (MailFlowNativePlugin.ACTION_SYNC.equals(action)) {
            MailFlowNativePlugin.sendSyncAction();
            return;
        }

        if (MailFlowNativePlugin.ACTION_INSTALL_UPDATE.equals(action)) {
            MailFlowNativePlugin.installDownloadedUpdateFromIntent();
            return;
        }

        if (Intent.ACTION_VIEW.equals(action) && data != null && "mailflow".equalsIgnoreCase(data.getScheme())) {
            String route = data.getHost();
            if (route == null || route.isEmpty()) {
                route = data.getPath() == null ? "" : data.getPath().replaceFirst("^/", "");
            }

            if ("compose".equalsIgnoreCase(route)) {
                MailFlowNativePlugin.sendComposeAction();
                return;
            }

            if ("sync".equalsIgnoreCase(route)) {
                MailFlowNativePlugin.sendSyncAction();
                return;
            }
        }

        if ((Intent.ACTION_SENDTO.equals(action) || Intent.ACTION_VIEW.equals(action)) && data != null && "mailto".equalsIgnoreCase(data.getScheme())) {
            MailFlowNativePlugin.sendMailtoAction(data);
        }
    }

    private boolean markIntentHandled(Intent intent) {
        String action = intent.getAction();
        Uri data = intent.getData();
        String messageId = intent.getStringExtra("messageId");
        String key = String.valueOf(action) + "|" + String.valueOf(data) + "|" + String.valueOf(messageId);

        if (key.equals(lastHandledIntentKey)) return false;
        lastHandledIntentKey = key;
        return true;
    }

    private void configureCookies() {
        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP && bridge != null && bridge.getWebView() != null) {
            cookieManager.setAcceptThirdPartyCookies(bridge.getWebView(), true);
        }
    }

    private void flushCookies() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            CookieManager.getInstance().flush();
        }
    }
}
