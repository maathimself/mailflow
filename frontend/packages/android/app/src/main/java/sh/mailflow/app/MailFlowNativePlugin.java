package sh.mailflow.app;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.webkit.WebView;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.net.URI;
import java.net.URLDecoder;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.json.JSONException;

@CapacitorPlugin(
    name = "MailFlowNative",
    permissions = {
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class MailFlowNativePlugin extends Plugin {
    static final String ACTION_OPEN_MESSAGE = "sh.mailflow.app.OPEN_MESSAGE";
    static final String ACTION_COMPOSE = "sh.mailflow.app.COMPOSE";
    static final String ACTION_SYNC = "sh.mailflow.app.SYNC";
    private static final String CHANNEL_NEW_MAIL = "mailflow_new_mail";
    private static final String PREFS_NAME = "mailflow-native";
    private static final String PREF_HOST = "host";
    private static final String SETUP_URL = "file:///android_asset/public/index.html";

    private static final List<JSObject> pendingActions = new ArrayList<>();
    private static MailFlowNativePlugin instance;

    @Override
    public void load() {
        instance = this;
        createNotificationChannel(getContext());
    }

    @PluginMethod
    public void getHost(PluginCall call) {
        JSObject result = new JSObject();
        result.put("host", getSavedHost(getContext()));
        call.resolve(result);
    }

    @PluginMethod
    public void saveHost(PluginCall call) {
        String host = call.getString("host", "");
        String normalizedHost = normalizeHost(host);

        if (normalizedHost == null) {
            call.reject("Host must start with https:// or http://");
            return;
        }

        getPrefs(getContext()).edit().putString(PREF_HOST, normalizedHost).apply();

        JSObject result = new JSObject();
        result.put("host", normalizedHost);
        call.resolve(result);
    }

    @PluginMethod
    public void resetHost(PluginCall call) {
        getPrefs(getContext()).edit().remove(PREF_HOST).apply();
        getActivity().runOnUiThread(() -> getBridge().getWebView().loadUrl(SETUP_URL));
        call.resolve();
    }

    @PluginMethod
    public void setUnreadCount(PluginCall call) {
        call.resolve();
    }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (hasNotificationPermission()) {
            call.resolve(notificationPermissionResult("granted"));
            return;
        }

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            call.resolve(notificationPermissionResult("denied"));
            return;
        }

        requestPermissionForAlias("notifications", call, "notificationPermissionCallback");
    }

    @PluginMethod
    public void checkNotificationPermission(PluginCall call) {
        call.resolve(notificationPermissionResult(getNotificationPermissionState()));
    }

    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

        try {
            getContext().startActivity(intent);
        } catch (ActivityNotFoundException err) {
            Intent fallbackIntent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                .setData(Uri.parse("package:" + getContext().getPackageName()));
            fallbackIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(fallbackIntent);
        }

        call.resolve();
    }

    @PluginMethod
    public void showNewMail(PluginCall call) {
        if (!hasNotificationPermission()) {
            call.resolve();
            return;
        }

        String title = call.getString("title", "New mail");
        String body = call.getString("body", "You have new mail.");
        String messageId = call.getString("messageId", null);
        String accountId = call.getString("accountId", null);
        String folder = call.getString("folder", "INBOX");
        JSObject message = call.getObject("message");

        Intent intent = new Intent(getContext(), MainActivity.class);
        intent.setAction(ACTION_OPEN_MESSAGE);
        intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        putExtra(intent, "messageId", messageId);
        putExtra(intent, "accountId", accountId);
        putExtra(intent, "folder", folder);
        if (message != null) putExtra(intent, "message", message.toString());

        int notificationId = Math.abs(UUID.randomUUID().hashCode());
        PendingIntent pendingIntent = PendingIntent.getActivity(
            getContext(),
            notificationId,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(getContext(), CHANNEL_NEW_MAIL)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT);

        NotificationManagerCompat.from(getContext()).notify(notificationId, builder.build());
        call.resolve();
    }

    @PluginMethod
    public void getPendingActions(PluginCall call) {
        JSObject result = new JSObject();
        synchronized (pendingActions) {
            result.put("actions", new JSArray(new ArrayList<>(pendingActions)));
        }
        call.resolve(result);
    }

    @PluginMethod
    public void ackAction(PluginCall call) {
        String id = call.getString("id", null);
        if (id != null) {
            synchronized (pendingActions) {
                pendingActions.removeIf((action) -> id.equals(action.getString("id")));
            }
        }
        call.resolve();
    }

    static String getSavedHost(Context context) {
        return getPrefs(context).getString(PREF_HOST, null);
    }

    static void injectPendingActions(WebView webView, Context context) {
        if (webView == null || context == null || !isConfiguredHost(context, webView.getUrl())) return;

        injectCapacitorCompat(webView);

        List<JSObject> actions;
        synchronized (pendingActions) {
            if (pendingActions.isEmpty()) return;
            actions = new ArrayList<>(pendingActions);
            pendingActions.clear();
        }

        String actionJson = new JSArray(actions).toString();
        String script = "(function(actions){"
            + "window.__mailflowPendingNativeActions=(window.__mailflowPendingNativeActions||[]).concat(actions);"
            + "var delivered=false;"
            + "var deliver=function(force){"
            + "if(delivered)return true;"
            + "if(!force&&window.__mailflowNativeBridgeReady!==true)return false;"
            + "delivered=true;"
            + "actions.forEach(function(payload){"
            + "window.dispatchEvent(new CustomEvent('mailflow:native-action',{detail:payload}));"
            + "window.postMessage({type:'mailflow:native-action',payload:payload},'*');"
            + "});"
            + "window.dispatchEvent(new CustomEvent('mailflow:native-actions-ready'));"
            + "window.postMessage({type:'mailflow:native-actions-ready'},'*');"
            + "return true;"
            + "};"
            + "if(!deliver(false)){"
            + "var attempts=0;"
            + "var timer=window.setInterval(function(){attempts+=1;if(deliver(false)||attempts>=100){if(!delivered)deliver(true);window.clearInterval(timer);}},100);"
            + "}"
            + "})( " + actionJson + " );";

        webView.post(() -> webView.evaluateJavascript(script, null));
    }

    static void injectCapacitorCompat(WebView webView) {
        if (webView == null) return;

        String script = "(function(){try{"
            + "window.Capacitor=window.Capacitor||{};"
            + "if(typeof window.Capacitor.triggerEvent!=='function'){"
            + "window.Capacitor.triggerEvent=function(eventName,target,eventData){"
            + "var receiver=target==='document'?document:window;"
            + "var event;"
            + "try{event=new CustomEvent(eventName,{detail:eventData});}"
            + "catch(e){event=document.createEvent('CustomEvent');event.initCustomEvent(eventName,false,false,eventData);}"
            + "receiver.dispatchEvent(event);"
            + "return true;"
            + "};"
            + "}"
            + "}catch(e){}})();";

        webView.post(() -> webView.evaluateJavascript(script, null));
    }

    static void sendOpenMessageAction(Intent intent) {
        JSObject action = newAction("open-message");
        copyStringExtra(intent, action, "messageId");
        copyStringExtra(intent, action, "accountId");
        copyStringExtra(intent, action, "folder");

        String messageJson = intent.getStringExtra("message");
        if (messageJson != null) {
            try {
                action.put("message", new JSObject(messageJson));
            } catch (JSONException ignored) {}
        }

        dispatchAction(action);
    }

    static void sendMailtoAction(Uri uri) {
        JSObject composeData = parseMailto(uri);
        if (composeData == null) return;

        JSObject action = newAction("new-mail");
        action.put("composeData", composeData);
        action.put("source", "mailto");
        dispatchAction(action);
    }

    static void sendComposeAction() {
        JSObject action = newAction("new-mail");
        action.put("composeData", new JSObject());
        action.put("source", "shortcut");
        dispatchAction(action);
    }

    static void sendSyncAction() {
        JSObject action = newAction("sync");
        action.put("source", "shortcut");
        dispatchAction(action);
    }

    private static void dispatchAction(JSObject action) {
        synchronized (pendingActions) {
            pendingActions.add(action);
        }

        if (instance != null) {
            instance.injectPendingActionsToWebView();
        }
    }

    private void injectPendingActionsToWebView() {
        if (getBridge() == null) return;
        injectPendingActions(getBridge().getWebView(), getContext());
    }

    private static JSObject newAction(String actionName) {
        JSObject action = new JSObject();
        action.put("id", UUID.randomUUID().toString());
        action.put("action", actionName);
        return action;
    }

    private static JSObject parseMailto(Uri uri) {
        if (uri == null || !"mailto".equalsIgnoreCase(uri.getScheme())) return null;

        String schemeSpecificPart = uri.getEncodedSchemeSpecificPart();
        String[] parts = (schemeSpecificPart == null ? "" : schemeSpecificPart).split("\\?", 2);
        String addressPart = parts.length > 0 ? parts[0] : "";
        String queryPart = parts.length > 1 ? parts[1] : "";

        JSObject composeData = new JSObject();
        composeData.put("to", new JSArray(unique(splitAddresses(decodePath(addressPart)))));
        composeData.put("cc", new JSArray());
        composeData.put("bcc", new JSArray());
        composeData.put("subject", "");
        composeData.put("body", "");

        for (String pair : queryPart.split("&")) {
            if (pair.isEmpty()) continue;

            String[] queryParts = pair.split("=", 2);
            String normalizedName = decodeQuery(queryParts[0]).toLowerCase();
            String value = queryParts.length > 1 ? decodeQuery(queryParts[1]) : "";

            if ("to".equals(normalizedName)) {
                composeData.put("to", new JSArray(unique(merge(composeData.optJSONArray("to"), splitAddresses(value)))));
            } else if ("cc".equals(normalizedName)) {
                composeData.put("cc", new JSArray(unique(splitAddresses(value))));
            } else if ("bcc".equals(normalizedName)) {
                composeData.put("bcc", new JSArray(unique(splitAddresses(value))));
            } else if ("subject".equals(normalizedName)) {
                composeData.put("subject", value);
            } else if ("body".equals(normalizedName)) {
                composeData.put("body", value);
            }
        }

        return composeData;
    }

    private static List<String> splitAddresses(String value) {
        List<String> addresses = new ArrayList<>();
        if (value == null) return addresses;
        for (String item : value.split(",")) {
            String address = item.trim();
            if (!address.isEmpty()) addresses.add(address);
        }
        return addresses;
    }

    private static List<String> merge(org.json.JSONArray current, List<String> next) {
        List<String> merged = new ArrayList<>();
        if (current != null) {
            for (int i = 0; i < current.length(); i++) {
                String value = current.optString(i, "");
                if (!value.isEmpty()) merged.add(value);
            }
        }
        merged.addAll(next);
        return merged;
    }

    private static List<String> unique(List<String> values) {
        Set<String> set = new LinkedHashSet<>(values);
        return new ArrayList<>(set);
    }

    private static String decodePath(String value) {
        return decodeQuery((value == null ? "" : value).replace("+", "%2B"));
    }

    private static String decodeQuery(String value) {
        try {
            return URLDecoder.decode(value == null ? "" : value, "UTF-8");
        } catch (Exception ignored) {
            return value == null ? "" : value;
        }
    }

    private static String normalizeHost(String host) {
        try {
            URI uri = new URI(host.trim());
            String scheme = uri.getScheme();
            if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) return null;
            if (uri.getHost() == null) return null;

            return new URI(scheme.toLowerCase(), null, uri.getHost(), uri.getPort(), null, null, null).toString();
        } catch (Exception ignored) {
            return null;
        }
    }

    private static SharedPreferences getPrefs(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    private static boolean isConfiguredHost(Context context, String url) {
        String host = getSavedHost(context);
        return host != null && url != null && url.startsWith(host);
    }

    private static void createNotificationChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;

        NotificationChannel channel = new NotificationChannel(
            CHANNEL_NEW_MAIL,
            "New mail",
            NotificationManager.IMPORTANCE_DEFAULT
        );
        channel.setDescription("New mail notifications from MailFlow.");
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    @PermissionCallback
    private void notificationPermissionCallback(PluginCall call) {
        call.resolve(notificationPermissionResult(getNotificationPermissionState()));
    }

    private boolean hasNotificationPermission() {
        if (!NotificationManagerCompat.from(getContext()).areNotificationsEnabled()) {
            return false;
        }

        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || ContextCompat.checkSelfPermission(
            getContext(),
            Manifest.permission.POST_NOTIFICATIONS
        ) == PackageManager.PERMISSION_GRANTED;
    }

    private String getNotificationPermissionState() {
        if (hasNotificationPermission()) {
            return "granted";
        }

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return "denied";

        PermissionState state = getPermissionState("notifications");
        if (state == PermissionState.DENIED) return "denied";
        return "default";
    }

    private JSObject notificationPermissionResult(String permission) {
        JSObject result = new JSObject();
        result.put("permission", permission);
        return result;
    }

    private static void putExtra(Intent intent, String key, String value) {
        if (value != null) intent.putExtra(key, value);
    }

    private static void copyStringExtra(Intent intent, JSObject target, String key) {
        String value = intent.getStringExtra(key);
        if (value != null) target.put(key, value);
    }
}
