package sh.mailflow.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private String lastHandledIntentKey = null;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(MailFlowNativePlugin.class);
        super.onCreate(savedInstanceState);

        if (bridge != null) {
            bridge.setWebViewClient(new MailFlowWebViewClient(bridge, this));
            String savedHost = MailFlowNativePlugin.getSavedHost(this);
            if (savedHost != null) {
                bridge.getWebView().post(() -> bridge.getWebView().loadUrl(savedHost));
            }
        }

        handleNativeIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleNativeIntent(intent);
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

        if (MailFlowNativePlugin.ACTION_COMPOSE.equals(action)) {
            MailFlowNativePlugin.sendComposeAction();
            return;
        }

        if (MailFlowNativePlugin.ACTION_SYNC.equals(action)) {
            MailFlowNativePlugin.sendSyncAction();
            return;
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
}
