package sh.mailflow.app;

import android.Manifest;
import android.app.AlertDialog;
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
import android.os.Environment;
import android.provider.Settings;
import android.util.Log;
import android.webkit.WebView;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URLDecoder;
import java.net.URL;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONException;
import org.json.JSONObject;

@CapacitorPlugin(
    name = "MailFlowNative",
    permissions = {
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class MailFlowNativePlugin extends Plugin {
    static final String ACTION_OPEN_MESSAGE = "sh.mailflow.app.OPEN_MESSAGE";
    static final String ACTION_REPLY_MESSAGE = "sh.mailflow.app.REPLY_MESSAGE";
    static final String ACTION_DELETE_MESSAGE = "sh.mailflow.app.DELETE_MESSAGE";
    static final String ACTION_STAR_MESSAGE = "sh.mailflow.app.STAR_MESSAGE";
    static final String ACTION_COMPOSE = "sh.mailflow.app.COMPOSE";
    static final String ACTION_SYNC = "sh.mailflow.app.SYNC";
    static final String ACTION_INSTALL_UPDATE = "sh.mailflow.app.INSTALL_UPDATE";
    private static final String EXTRA_INTENT_SECRET = "sh.mailflow.app.INTENT_SECRET";
    private static final String TAG = "MailFlowUpdater";
    private static final String CHANNEL_NEW_MAIL = "mailflow_new_mail";
    private static final String CHANNEL_UPDATES = "mailflow_updates";
    private static final String PREFS_NAME = "mailflow-native";
    private static final String PREF_HOST = "host";
    private static final String PREF_INTENT_SECRET = "intent_secret";
    private static final String PREF_UPDATE_APK_PATH = "update_apk_path";
    private static final String PREF_UPDATE_VERSION = "update_version";
    private static final String PREF_UPDATE_RELEASE_NAME = "update_release_name";
    private static final String PREF_UPDATE_DIGEST = "update_digest";
    private static final String SETUP_URL = "file:///android_asset/public/index.html";
    private static final String UPDATE_RELEASE_URL = "https://api.github.com/repos/maathimself/mailflow/releases/latest";
    
    /* Old dev fork url
    private static final String UPDATE_RELEASE_URL = "https://api.github.com/repos/dcoffin88/mailflow/releases/latest";
    */
    
    private static final String UPDATE_ERROR_MESSAGE = "Could not check for MailFlow updates. Please visit the website instead.";
    private static final Pattern VERSION_PATTERN = Pattern.compile("\\d+(?:\\.\\d+){0,2}");

    private static final List<JSObject> pendingActions = new ArrayList<>();
    private static MailFlowNativePlugin instance;
    private ReleaseInfo updateInfo = null;
    private File downloadedUpdate = null;
    private boolean updateCheckStarted = false;
    private boolean installPendingPermission = false;

    @Override
    public void load() {
        instance = this;
        createNotificationChannel(getContext());
        restoreDownloadedUpdateState();
        checkForUpdatesInBackground(false, null);
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
            call.reject("Public MailFlow hosts must use https://. HTTP is allowed only for localhost and private IP addresses.");
            return;
        }

        if (normalizedHost.startsWith("http://")) {
            if (getActivity() == null || getActivity().isFinishing()) {
                call.reject("The unencrypted MailFlow host could not be confirmed.");
                return;
            }
            getActivity().runOnUiThread(() -> new AlertDialog.Builder(getActivity())
                .setTitle("Unencrypted MailFlow connection")
                .setMessage("Traffic to this MailFlow server is not encrypted. Your session cookie and email data can be read or changed by anyone who can observe this network. Continue only on a private network you trust.")
                .setPositiveButton("Use unencrypted connection", (dialog, which) -> persistHost(call, normalizedHost))
                .setNegativeButton("Cancel", (dialog, which) -> call.reject("The unencrypted MailFlow host was not saved."))
                .setOnCancelListener((dialog) -> call.reject("The unencrypted MailFlow host was not saved."))
                .show());
            return;
        }

        persistHost(call, normalizedHost);
    }

    private void persistHost(PluginCall call, String normalizedHost) {
        getPrefs(getContext()).edit().putString(PREF_HOST, normalizedHost).apply();
        if (getActivity() instanceof MainActivity) {
            ((MainActivity) getActivity()).configureNativeMessageBridge(normalizedHost);
        }
        MailFlowBackgroundSync.schedule(getContext());

        JSObject result = new JSObject();
        result.put("host", normalizedHost);
        call.resolve(result);
    }

    @PluginMethod
    public void resetHost(PluginCall call) {
        getPrefs(getContext()).edit().remove(PREF_HOST).apply();
        if (getActivity() instanceof MainActivity) {
            ((MainActivity) getActivity()).configureNativeMessageBridge(null);
        }
        getActivity().runOnUiThread(() -> getBridge().getWebView().loadUrl(SETUP_URL));
        call.resolve();
    }

    @PluginMethod
    public void setUnreadCount(PluginCall call) {
        Integer count = call.getInt("count");
        if (count != null) {
            MailFlowBackgroundWorker.updateUnreadBaseline(getContext(), count);
            MailFlowBackgroundSync.schedule(getContext());
        }
        call.resolve();
    }

    @PluginMethod
    public void checkForUpdates(PluginCall call) {
        checkForUpdatesInBackground(Boolean.TRUE.equals(call.getBoolean("verbose")), call);
    }

    private void checkForUpdatesInBackground(boolean verbose, PluginCall call) {
        if (!verbose && updateCheckStarted) {
            if (call != null) {
                JSObject result = new JSObject();
                result.put("updateAvailable", false);
                result.put("skipped", true);
                call.resolve(result);
            }
            return;
        }

        updateCheckStarted = true;
        if (verbose) {
            sendUpdateStatus(updateStatus("checking"));
        }

        new Thread(() -> {
            try {
                Log.i(TAG, "Checking for updates from " + UPDATE_RELEASE_URL);
                ReleaseInfo release = fetchLatestRelease();
                Log.i(TAG, "Latest release " + release.version + ", installed " + getInstalledVersion() + ", APK " + release.downloadUrl);
                if (!isNewerVersion(release.version, getInstalledVersion())) {
                    clearDownloadedUpdateState();
                    if (verbose) {
                        sendUpdateStatus(updateStatus("up-to-date"));
                    }

                    if (call != null) {
                        JSObject result = new JSObject();
                        result.put("updateAvailable", false);
                        call.resolve(result);
                    }
                    return;
                }

                if (release.downloadUrl == null) {
                    sendUpdateError("A MailFlow update is available, but no Android APK was found.");
                    if (call != null) {
                        JSObject result = new JSObject();
                        result.put("updateAvailable", true);
                        result.put("downloadAvailable", false);
                        call.resolve(result);
                    }
                    return;
                }

                updateInfo = release;
                downloadedUpdate = null;
                sendUpdateStatus(updateStatus("available", release.toStatusData()));

                if (call != null) {
                    JSObject result = new JSObject();
                    result.put("updateAvailable", true);
                    result.put("downloadAvailable", true);
                    call.resolve(result);
                }

                downloadUpdate(release);
            } catch (Exception error) {
                Log.e(TAG, "Update check failed", error);
                sendUpdateError(UPDATE_ERROR_MESSAGE);
                if (call != null) {
                    JSObject result = new JSObject();
                    result.put("updateAvailable", false);
                    result.put("error", error.getMessage());
                    call.resolve(result);
                }
            }
        }).start();
    }

    @PluginMethod
    public void installDownloadedUpdate(PluginCall call) {
        JSObject result = showUpdateReadyDialog();
        call.resolve(result);
    }

    @PluginMethod
    public void openDownloadedUpdate(PluginCall call) {
        JSObject result = showUpdateReadyDialog();
        call.resolve(result);
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
        String title = call.getString("title", "New mail");
        String body = call.getString("body", "You have new mail.");
        String messageId = call.getString("messageId", null);
        String accountId = call.getString("accountId", null);
        String folder = call.getString("folder", "INBOX");
        JSObject message = call.getObject("message");

        postNewMailNotification(getContext(), title, body, messageId, accountId, folder, message);
        call.resolve();
    }

    static void postNewMailNotification(Context context, String title, String body, String messageId, String accountId, String folder, JSObject message) {
        if (!hasNotificationPermission(context)) return;

        Intent intent = new Intent(context, MainActivity.class);
        intent.setAction(ACTION_OPEN_MESSAGE);
        authenticateIntent(context, intent);
        intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        putExtra(intent, "messageId", messageId);
        putExtra(intent, "accountId", accountId);
        putExtra(intent, "folder", folder);
        if (message != null) putExtra(intent, "message", message.toString());

        int notificationId = Math.abs(UUID.randomUUID().hashCode());
        PendingIntent pendingIntent = PendingIntent.getActivity(
            context,
            notificationId,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        PendingIntent replyPendingIntent = messageActionPendingIntent(
            context,
            notificationId,
            ACTION_REPLY_MESSAGE,
            messageId,
            accountId,
            folder,
            message
        );
        PendingIntent deletePendingIntent = messageActionPendingIntent(
            context,
            notificationId,
            ACTION_DELETE_MESSAGE,
            messageId,
            accountId,
            folder,
            message
        );
        PendingIntent starPendingIntent = messageActionPendingIntent(
            context,
            notificationId,
            ACTION_STAR_MESSAGE,
            messageId,
            accountId,
            folder,
            message
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_NEW_MAIL)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(pendingIntent)
            .addAction(R.mipmap.ic_launcher, "Reply", replyPendingIntent)
            .addAction(R.mipmap.ic_launcher, "Delete", deletePendingIntent)
            .addAction(R.mipmap.ic_launcher, "Star", starPendingIntent)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT);

        try {
            NotificationManagerCompat.from(context).notify(notificationId, builder.build());
        } catch (SecurityException ignored) {}
    }

    private static PendingIntent messageActionPendingIntent(Context context, int notificationId, String action, String messageId, String accountId, String folder, JSObject message) {
        boolean backgroundAction = ACTION_DELETE_MESSAGE.equals(action) || ACTION_STAR_MESSAGE.equals(action);
        Intent intent = new Intent(
            context,
            backgroundAction ? MailFlowNotificationActionReceiver.class : MainActivity.class
        );
        intent.setAction(action);
        authenticateIntent(context, intent);
        if (!backgroundAction) {
            intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        }
        intent.putExtra("notificationId", notificationId);
        putExtra(intent, "messageId", messageId);
        putExtra(intent, "accountId", accountId);
        putExtra(intent, "folder", folder);
        if (message != null) putExtra(intent, "message", message.toString());

        int requestCode = Math.abs((action + ":" + notificationId).hashCode());
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        return backgroundAction
            ? PendingIntent.getBroadcast(context, requestCode, intent, flags)
            : PendingIntent.getActivity(context, requestCode, intent, flags);
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
        return normalizeHost(getPrefs(context).getString(PREF_HOST, null));
    }

    static boolean isPrivilegedNativeAction(String action) {
        return ACTION_OPEN_MESSAGE.equals(action)
            || ACTION_REPLY_MESSAGE.equals(action)
            || ACTION_DELETE_MESSAGE.equals(action)
            || ACTION_STAR_MESSAGE.equals(action)
            || ACTION_COMPOSE.equals(action)
            || ACTION_SYNC.equals(action)
            || ACTION_INSTALL_UPDATE.equals(action);
    }

    static boolean isTrustedNativeIntent(Context context, Intent intent) {
        if (context == null || intent == null || !isPrivilegedNativeAction(intent.getAction())) {
            return false;
        }
        return NativeSecurity.secretsMatch(
            getIntentSecret(context),
            intent.getStringExtra(EXTRA_INTENT_SECRET)
        );
    }

    private static void authenticateIntent(Context context, Intent intent) {
        intent.putExtra(EXTRA_INTENT_SECRET, getIntentSecret(context));
    }

    private static String getIntentSecret(Context context) {
        SharedPreferences prefs = getPrefs(context);
        String existing = prefs.getString(PREF_INTENT_SECRET, null);
        if (existing != null && !existing.isEmpty()) return existing;

        String generated = UUID.randomUUID().toString();
        prefs.edit().putString(PREF_INTENT_SECRET, generated).apply();
        return generated;
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
            + "});"
            + "window.dispatchEvent(new CustomEvent('mailflow:native-actions-ready'));"
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
            + "var androidBridge=window.MailFlowAndroid;"
            + "var nativeRequests=window.__mailflowAndroidRequests=window.__mailflowAndroidRequests||{};"
            + "if(androidBridge&&typeof androidBridge.postMessage==='function'){androidBridge.onmessage=function(event){try{var response=JSON.parse(event.data||'{}');var resolve=nativeRequests[response.id];if(!resolve)return;delete nativeRequests[response.id];resolve(response.result||null);}catch(e){}};}"
            + "var nativeCall=function(method,args,fallback){if(!androidBridge||typeof androidBridge.postMessage!=='function')return Promise.resolve(fallback||null);return new Promise(function(resolve){var id=String(Date.now())+Math.random();nativeRequests[id]=resolve;androidBridge.postMessage(JSON.stringify({id:id,method:method,args:args||{}}));});};"
            + "var plugin=function(){return window.Capacitor&&window.Capacitor.Plugins&&window.Capacitor.Plugins.MailFlowNative;};"
            + "var call=function(method,args,fallback){var p=plugin();if(!p||typeof p[method]!=='function')return Promise.resolve(fallback||null);return p[method](args||{}).catch(function(){return fallback||null;});};"
            + "window.mailflowNative=window.mailflowNative||{};"
            + "window.mailflowNative.platform='android';"
            + "window.mailflowNative.updates=window.mailflowNative.updates||{};"
            + "window.mailflowNative.updates.check=function(verbose){return call('checkForUpdates',{verbose:!!verbose});};"
            + "window.mailflowNative.updates.installDownloaded=function(){return nativeCall('installDownloadedUpdate',{},null).then(function(result){return result||call('installDownloadedUpdate',{}, {installed:false,reason:'unavailable'});});};"
            + "window.mailflowNative.updates.installAuto=window.mailflowNative.updates.installDownloaded;"
            + "window.mailflowNative.updates.openDownload=function(){return call('openDownloadedUpdate',{});};"
            + "window.mailflowNative.updates.onStatus=function(callback){if(typeof callback!=='function')return function(){};var handler=function(event){callback(event.detail);};window.addEventListener('mailflow:update-status',handler);return function(){window.removeEventListener('mailflow:update-status',handler);};};"
            + "window.mailflowNative.notifications=window.mailflowNative.notifications||{};"
            + "window.mailflowNative.notifications.showNewMail=function(notification){return nativeCall('showNewMail',notification||{},null).then(function(result){return result||call('showNewMail',notification||{});});};"
            + "window.mailflowNative.notifications.checkPermission=function(){return call('checkNotificationPermission',{},{}).then(function(result){return result&&result.permission||'default';});};"
            + "window.mailflowNative.notifications.requestPermission=function(){return call('requestNotificationPermission',{},{}).then(function(result){return result&&result.permission||'default';});};"
            + "window.mailflowNative.notifications.openSettings=function(){return call('openNotificationSettings',{});};"
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

    static void sendReplyMessageAction(Intent intent) {
        sendMessageNotificationAction(intent, "reply-message");
    }

    static void sendDeleteMessageAction(Intent intent) {
        sendMessageNotificationAction(intent, "delete-message");
    }

    static void sendStarMessageAction(Intent intent) {
        sendMessageNotificationAction(intent, "star-message");
    }

    private static void sendMessageNotificationAction(Intent intent, String actionName) {
        int notificationId = intent.getIntExtra("notificationId", -1);
        if (notificationId != -1 && instance != null) {
            NotificationManagerCompat.from(instance.getContext()).cancel(notificationId);
        }

        JSObject action = newAction(actionName);
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

    static void installDownloadedUpdateFromIntent() {
        if (instance != null) {
            instance.showUpdateReadyDialog();
        }
    }

    static void resumePendingUpdateInstall() {
        if (instance != null) {
            instance.continuePendingUpdateInstall();
        }
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
        return NativeSecurity.normalizeHost(host);
    }

    private static SharedPreferences getPrefs(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    private ReleaseInfo fetchLatestRelease() throws Exception {
        JSONObject release = requestJson(UPDATE_RELEASE_URL);
        org.json.JSONArray assets = release.optJSONArray("assets");
        JSONObject apkAsset = null;

        if (assets != null) {
            for (int i = 0; i < assets.length(); i++) {
                JSONObject asset = assets.optJSONObject(i);
                if (asset == null) continue;

                String name = asset.optString("name", "");
                String downloadUrl = asset.optString("browser_download_url", "");
                if (name.toLowerCase().endsWith(".apk") && !downloadUrl.isEmpty()) {
                    apkAsset = asset;
                    break;
                }
            }
        }

        ReleaseInfo info = new ReleaseInfo();
        info.version = release.optString("tag_name", release.optString("name", ""));
        info.releaseName = release.optString("name", info.version);
        info.releaseNotes = release.optString("body", "");
        info.releaseDate = release.optString("published_at", "");

        if (apkAsset != null) {
            info.assetName = apkAsset.optString("name", "MailFlow.apk");
            info.downloadUrl = apkAsset.optString("browser_download_url", null);
            info.digest = apkAsset.optString("digest", null);
        }

        return info;
    }

    private JSONObject requestJson(String url) throws Exception {
        HttpURLConnection connection = openFollowingHttpsRedirects(url);
        int status = connection.getResponseCode();

        if (status < 200 || status >= 300) {
            connection.disconnect();
            throw new Exception("Update request failed with status " + status);
        }

        try (InputStream stream = connection.getInputStream()) {
            return new JSONObject(readStream(stream));
        } finally {
            connection.disconnect();
        }
    }

    private void downloadUpdate(ReleaseInfo release) {
        sendUpdateStatus(updateStatus("downloading"));

        new Thread(() -> {
            try {
                Log.i(TAG, "Downloading update APK from " + release.downloadUrl);
                File directory = getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                if (directory == null) directory = getContext().getCacheDir();
                directory = new File(directory, "updates");
                if (!directory.exists()) directory.mkdirs();

                File output = uniqueFile(directory, sanitizeApkName(release.assetName));
                HttpURLConnection connection = openFollowingHttpsRedirects(release.downloadUrl);
                int status = connection.getResponseCode();
                if (status < 200 || status >= 300) {
                    connection.disconnect();
                    throw new Exception("APK download failed with status " + status);
                }

                try (
                    InputStream input = new BufferedInputStream(connection.getInputStream());
                    FileOutputStream outputStream = new FileOutputStream(output)
                ) {
                    byte[] buffer = new byte[8192];
                    int read;
                    while ((read = input.read(buffer)) != -1) {
                        outputStream.write(buffer, 0, read);
                    }
                } finally {
                    connection.disconnect();
                }

                verifyReleaseDigest(release, output);
                downloadedUpdate = output;
                persistDownloadedUpdateState(release, output);
                Log.i(TAG, "Downloaded update APK to " + output.getAbsolutePath());
                sendUpdateStatus(updateStatus("downloaded", release.toStatusData(output.getAbsolutePath())));
                postUpdateReadyNotification(release);
            } catch (Exception error) {
                Log.e(TAG, "Update download failed", error);
                sendUpdateError("The MailFlow update could not be downloaded.");
            }
        }).start();
    }

    private HttpURLConnection openConnection(String url) throws Exception {
        if (!NativeSecurity.isHttpsUrl(url)) {
            throw new Exception("Update URLs must use HTTPS.");
        }
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(30000);
        connection.setRequestProperty("Accept", "application/vnd.github+json");
        connection.setRequestProperty("User-Agent", "MailFlow/" + getInstalledVersion());
        return connection;
    }

    private HttpURLConnection openFollowingHttpsRedirects(String initialUrl) throws Exception {
        String url = initialUrl;
        for (int redirects = 0; redirects <= 5; redirects++) {
            HttpURLConnection connection = openConnection(url);
            int status = connection.getResponseCode();
            if (status < 300 || status >= 400) return connection;

            String location = connection.getHeaderField("Location");
            connection.disconnect();
            if (location == null || redirects == 5) {
                throw new Exception("Update redirect could not be followed safely.");
            }
            url = new URL(new URL(url), location).toString();
        }
        throw new Exception("Too many update redirects.");
    }

    private String getInstalledVersion() {
        try {
            return getContext()
                .getPackageManager()
                .getPackageInfo(getContext().getPackageName(), 0)
                .versionName;
        } catch (Exception ignored) {
            return "0.0.0";
        }
    }

    private JSObject startDownloadedUpdateInstall() {
        JSObject result = new JSObject();
        restoreDownloadedUpdateState();

        if (downloadedUpdate == null || !downloadedUpdate.exists()) {
            Log.w(TAG, "Install requested with no downloaded APK");
            result.put("installed", false);
            result.put("reason", "missing-download");
            return result;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getContext().getPackageManager().canRequestPackageInstalls()) {
            Log.i(TAG, "Install requires unknown-apps permission");
            installPendingPermission = true;
            openInstallPermissionSettings();
            result.put("installed", false);
            result.put("reason", "permission-required");
            return result;
        }

        try {
            verifyReleaseDigest(updateInfo, downloadedUpdate);
            installPendingPermission = false;
            Uri uri = FileProvider.getUriForFile(
                getContext(),
                getContext().getPackageName() + ".fileprovider",
                downloadedUpdate
            );
            Intent intent = new Intent(Intent.ACTION_INSTALL_PACKAGE);
            intent.setData(uri);
            intent.putExtra(Intent.EXTRA_NOT_UNKNOWN_SOURCE, true);
            intent.putExtra(Intent.EXTRA_RETURN_RESULT, true);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

            getActivity().startActivity(intent);
            Log.i(TAG, "Started Android package installer for " + downloadedUpdate.getAbsolutePath());
            result.put("installed", true);
            return result;
        } catch (Exception error) {
            Log.e(TAG, "Could not start package installer", error);
            sendUpdateError("The update was downloaded, but MailFlow could not start the installer.");
            result.put("installed", false);
            result.put("reason", "launch-failed");
            result.put("error", error.getMessage());
            return result;
        }
    }

    private void continuePendingUpdateInstall() {
        if (!installPendingPermission || downloadedUpdate == null || !downloadedUpdate.exists()) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getContext().getPackageManager().canRequestPackageInstalls()) return;
        startDownloadedUpdateInstall();
    }

    private JSObject showUpdateReadyDialog() {
        JSObject result = new JSObject();
        restoreDownloadedUpdateState();

        if (downloadedUpdate == null || !downloadedUpdate.exists()) {
            Log.w(TAG, "Install dialog requested with no downloaded APK");
            result.put("installed", false);
            result.put("reason", "missing-download");
            return result;
        }

        if (getActivity() == null || getActivity().isFinishing()) {
            return startDownloadedUpdateInstall();
        }

        String version = updateInfo == null || updateInfo.version == null || updateInfo.version.isEmpty()
            ? "update"
            : updateInfo.version;

        getActivity().runOnUiThread(() -> {
            if (getActivity() == null || getActivity().isFinishing()) {
                startDownloadedUpdateInstall();
                return;
            }

            new AlertDialog.Builder(getActivity())
                .setTitle("Update ready")
                .setMessage("MailFlow " + version + " has been downloaded and is ready to install.")
                .setPositiveButton("Install", (dialog, which) -> startDownloadedUpdateInstall())
                .setNegativeButton("Later", null)
                .show();
        });

        result.put("installed", true);
        result.put("dialog", true);
        return result;
    }

    private void persistDownloadedUpdateState(ReleaseInfo release, File file) {
        if (release == null || file == null) return;

        getPrefs(getContext())
            .edit()
            .putString(PREF_UPDATE_APK_PATH, file.getAbsolutePath())
            .putString(PREF_UPDATE_VERSION, release.version == null ? "" : release.version)
            .putString(PREF_UPDATE_RELEASE_NAME, release.releaseName == null ? "" : release.releaseName)
            .putString(PREF_UPDATE_DIGEST, release.digest == null ? "" : release.digest)
            .apply();
    }

    private void restoreDownloadedUpdateState() {
        if (downloadedUpdate != null && downloadedUpdate.exists()) return;

        SharedPreferences prefs = getPrefs(getContext());
        String path = prefs.getString(PREF_UPDATE_APK_PATH, null);
        if (path == null || path.isEmpty()) return;

        File file = new File(path);
        if (!file.exists()) {
            clearDownloadedUpdateState();
            return;
        }

        downloadedUpdate = file;
        if (updateInfo == null) {
            ReleaseInfo restored = new ReleaseInfo();
            restored.version = prefs.getString(PREF_UPDATE_VERSION, "");
            restored.releaseName = prefs.getString(PREF_UPDATE_RELEASE_NAME, restored.version);
            restored.assetName = file.getName();
            restored.digest = prefs.getString(PREF_UPDATE_DIGEST, "");
            updateInfo = restored;
        }
    }

    private void clearDownloadedUpdateState() {
        downloadedUpdate = null;
        installPendingPermission = false;
        getPrefs(getContext())
            .edit()
            .remove(PREF_UPDATE_APK_PATH)
            .remove(PREF_UPDATE_VERSION)
            .remove(PREF_UPDATE_RELEASE_NAME)
            .remove(PREF_UPDATE_DIGEST)
            .apply();
    }

    private void openInstallPermissionSettings() {
        Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
            .setData(Uri.parse("package:" + getContext().getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
    }

    private void sendUpdateError(String message) {
        JSObject status = updateStatus("error");
        status.put("message", message);
        sendUpdateStatus(status);
    }

    private void postUpdateReadyNotification(ReleaseInfo release) {
        Intent openIntent = new Intent(getContext(), MainActivity.class);
        openIntent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        PendingIntent openPendingIntent = PendingIntent.getActivity(
            getContext(),
            1002,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Intent installIntent = new Intent(getContext(), MainActivity.class);
        installIntent.setAction(ACTION_INSTALL_UPDATE);
        authenticateIntent(getContext(), installIntent);
        installIntent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        PendingIntent installPendingIntent = PendingIntent.getActivity(
            getContext(),
            1003,
            installIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(getContext(), CHANNEL_UPDATES)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("MailFlow update ready")
            .setContentText("MailFlow " + release.version + " has been downloaded.")
            .setStyle(new NotificationCompat.BigTextStyle().bigText("MailFlow " + release.version + " has been downloaded and is ready to install."))
            .setContentIntent(openPendingIntent)
            .addAction(R.mipmap.ic_launcher, "Install", installPendingIntent)
            .setAutoCancel(false)
            .setOngoing(false)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT);

        if (hasNotificationPermission(getContext())) {
            try {
                NotificationManagerCompat.from(getContext()).notify(1002, builder.build());
            } catch (SecurityException ignored) {}
        }
    }

    private void sendUpdateStatus(JSObject status) {
        notifyListeners("updateStatus", status);

        if (getBridge() == null || getBridge().getWebView() == null) return;
        String script = "(function(status){"
            + "window.dispatchEvent(new CustomEvent('mailflow:update-status',{detail:status}));"
            + "})(" + status.toString() + ");";
        getBridge().getWebView().post(() -> getBridge().getWebView().evaluateJavascript(script, null));
    }

    private JSObject updateStatus(String type) {
        JSObject status = new JSObject();
        status.put("type", type);
        return status;
    }

    private JSObject updateStatus(String type, JSObject data) {
        JSObject status = updateStatus(type);
        status.put("data", data);
        return status;
    }

    private static boolean isNewerVersion(String candidate, String current) {
        int[] next = parseVersion(candidate);
        int[] installed = parseVersion(current);
        if (next == null || installed == null) return false;

        for (int i = 0; i < 3; i++) {
            if (next[i] > installed[i]) return true;
            if (next[i] < installed[i]) return false;
        }

        return false;
    }

    private static int[] parseVersion(String value) {
        Matcher matcher = VERSION_PATTERN.matcher(value == null ? "" : value);
        if (!matcher.find()) return null;

        String[] parts = matcher.group().split("\\.");
        int[] version = new int[] { 0, 0, 0 };
        for (int i = 0; i < Math.min(parts.length, 3); i++) {
            try {
                version[i] = Integer.parseInt(parts[i]);
            } catch (NumberFormatException ignored) {
                return null;
            }
        }
        return version;
    }

    private static String readStream(InputStream stream) throws Exception {
        StringBuilder builder = new StringBuilder();
        byte[] buffer = new byte[8192];
        int read;
        while ((read = stream.read(buffer)) != -1) {
            builder.append(new String(buffer, 0, read, "UTF-8"));
        }
        return builder.toString();
    }

    private static File uniqueFile(File directory, String filename) {
        File file = new File(directory, filename);
        if (!file.exists()) return file;

        String base = filename.replaceFirst("\\.apk$", "");
        for (int i = 1; i < 1000; i++) {
            file = new File(directory, base + " (" + i + ").apk");
            if (!file.exists()) return file;
        }
        return new File(directory, base + "-" + UUID.randomUUID() + ".apk");
    }

    private static String sanitizeApkName(String value) {
        String name = value == null ? "MailFlow.apk" : value.replaceAll("[^A-Za-z0-9._ -]", "_");
        if (!name.toLowerCase().endsWith(".apk")) name += ".apk";
        return name;
    }

    private static void verifyReleaseDigest(ReleaseInfo release, File file) throws Exception {
        String digest = release == null || release.digest == null ? "" : release.digest.trim();
        if (digest.isEmpty()) return;
        if (!digest.matches("(?i)^sha256:[a-f0-9]{64}$")) {
            throw new Exception("The release asset has an unsupported digest.");
        }

        MessageDigest hasher = MessageDigest.getInstance("SHA-256");
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) {
                hasher.update(buffer, 0, read);
            }
        }

        StringBuilder actual = new StringBuilder();
        for (byte value : hasher.digest()) {
            actual.append(String.format("%02x", value & 0xff));
        }
        if (!NativeSecurity.secretsMatch(digest.substring("sha256:".length()).toLowerCase(java.util.Locale.ROOT), actual.toString())) {
            throw new Exception("The update digest does not match the release asset.");
        }
    }

    private static boolean isConfiguredHost(Context context, String url) {
        String host = getSavedHost(context);
        return host != null && NativeSecurity.isSameOrigin(host, url);
    }

    private static class ReleaseInfo {
        String version;
        String releaseName;
        String releaseNotes;
        String releaseDate;
        String assetName;
        String downloadUrl;
        String digest;

        JSObject toStatusData() {
            return toStatusData(null);
        }

        JSObject toStatusData(String filePath) {
            JSObject data = new JSObject();
            data.put("releaseNotes", releaseNotes);
            data.put("releaseName", releaseName);
            data.put("releaseDate", releaseDate);
            data.put("updateUrl", downloadUrl);
            data.put("manual", true);
            if (filePath != null) data.put("filePath", filePath);
            return data;
        }
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
        if (manager != null) {
            manager.createNotificationChannel(channel);

            NotificationChannel updatesChannel = new NotificationChannel(
                CHANNEL_UPDATES,
                "Updates",
                NotificationManager.IMPORTANCE_DEFAULT
            );
            updatesChannel.setDescription("MailFlow app update notifications.");
            manager.createNotificationChannel(updatesChannel);
        }
    }

    @PermissionCallback
    private void notificationPermissionCallback(PluginCall call) {
        call.resolve(notificationPermissionResult(getNotificationPermissionState()));
    }

    private boolean hasNotificationPermission() {
        return hasNotificationPermission(getContext());
    }

    private static boolean hasNotificationPermission(Context context) {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) {
            return false;
        }

        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || ContextCompat.checkSelfPermission(
            context,
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

    static JSObject handleNativeBridgeRequest(Context context, String method, JSONObject args) throws JSONException {
        if ("showNewMail".equals(method)) {
            JSONObject notification = args == null ? new JSONObject() : args;
            JSONObject messageObject = notification.optJSONObject("message");
            JSObject message = messageObject == null ? null : JSObject.fromJSONObject(messageObject);
            postNewMailNotification(
                context,
                notification.optString("title", "New mail"),
                notification.optString("body", "You have new mail."),
                notification.optString("messageId", null),
                notification.optString("accountId", null),
                notification.optString("folder", "INBOX"),
                message
            );
            JSObject result = new JSObject();
            result.put("shown", true);
            return result;
        }

        if ("installDownloadedUpdate".equals(method) && instance != null) {
            return instance.showUpdateReadyDialog();
        }

        JSObject result = new JSObject();
        result.put("installed", false);
        result.put("reason", "unavailable");
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
