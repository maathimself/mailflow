package sh.mailflow.app;

import android.content.Context;
import android.webkit.CookieManager;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

public class MailFlowNotificationActionWorker extends Worker {
    static final String KEY_ACTION = "action";
    static final String KEY_MESSAGE_ID = "messageId";

    public MailFlowNotificationActionWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        String host = MailFlowNativePlugin.getSavedHost(context);
        String action = getInputData().getString(KEY_ACTION);
        String messageId = getInputData().getString(KEY_MESSAGE_ID);
        if (host == null || host.isEmpty() || action == null || messageId == null || messageId.isEmpty()) {
            return Result.failure();
        }

        String cookie = CookieManager.getInstance().getCookie(host);
        if (cookie == null || cookie.trim().isEmpty()) return Result.failure();

        try {
            if (MailFlowNativePlugin.ACTION_DELETE_MESSAGE.equals(action)) {
                request(host + "/api/mail/messages/" + messageId, "DELETE", cookie, null);
            } else if (MailFlowNativePlugin.ACTION_STAR_MESSAGE.equals(action)) {
                request(host + "/api/mail/messages/" + messageId + "/star", "PATCH", cookie, "{\"starred\":true}");
            } else {
                return Result.failure();
            }

            return Result.success();
        } catch (Exception ignored) {
            return Result.retry();
        }
    }

    private static void request(String url, String method, String cookie, String body) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(15000);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("Cookie", cookie);

        if (body != null) {
            byte[] bytes = body.getBytes("UTF-8");
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(bytes);
            }
        }

        int status = connection.getResponseCode();
        connection.disconnect();
        if (status < 200 || status >= 300) {
            throw new IllegalStateException("MailFlow notification action failed: HTTP " + status);
        }
    }
}
