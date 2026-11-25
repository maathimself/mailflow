package sh.mailflow.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.webkit.CookieManager;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import javax.net.ssl.SSLSocketFactory;
import org.json.JSONArray;
import org.json.JSONObject;

public class MailFlowBackgroundWorker extends Worker {
    private static final String PREFS_NAME = "mailflow-background-sync";
    private static final String PREF_LAST_UNREAD_TOTAL = "lastUnreadTotal";

    public MailFlowBackgroundWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    static void updateUnreadBaseline(Context context, int unreadTotal) {
        if (context == null) return;
        context.getApplicationContext()
            .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putInt(PREF_LAST_UNREAD_TOTAL, Math.max(0, unreadTotal))
            .apply();
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        String host = MailFlowNativePlugin.getSavedHost(context);
        if (host == null || host.isEmpty()) return Result.success();
        // The certificate is missing and the user has been told once: no retries until the app is opened.
        if (MailFlowClientCertificate.isMissing(context, host)) return Result.success();

        String cookie = CookieManager.getInstance().getCookie(host);
        if (cookie == null || cookie.trim().isEmpty()) return Result.success();

        try {
            SSLSocketFactory socketFactory = MailFlowClientCertificate.socketFactory(context, host);
            JSONObject counts = getJson(host + "/api/mail/unread-counts", cookie, socketFactory);
            int unreadTotal = counts.optInt("total", 0);

            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            int lastUnreadTotal = prefs.getInt(PREF_LAST_UNREAD_TOTAL, -1);

            if (lastUnreadTotal >= 0 && unreadTotal > lastUnreadTotal) {
                JSONObject latest = getLatestUnreadMessage(host, cookie, socketFactory);
                int delta = unreadTotal - lastUnreadTotal;
                String title = latest.optString("from_name", latest.optString("from_email", "New mail"));
                String body = latest.optString("subject", delta == 1 ? "You have new mail." : delta + " new messages");
                String messageId = latest.optString("id", null);
                String accountId = latest.optString("account_id", null);
                String folder = latest.optString("folder", "INBOX");

                MailFlowNativePlugin.postNewMailNotification(
                    context,
                    title == null || title.isEmpty() ? "New mail" : title,
                    body == null || body.isEmpty() ? "You have new mail." : body,
                    messageId,
                    accountId,
                    folder,
                    com.getcapacitor.JSObject.fromJSONObject(latest)
                );
            }

            updateUnreadBaseline(context, unreadTotal);
            return Result.success();
        } catch (MailFlowClientCertificate.MissingCertificateException error) {
            MailFlowClientCertificate.reportMissing(context, host);
            return Result.success();
        } catch (Exception ignored) {
            return Result.retry();
        }
    }

    private static JSONObject getLatestUnreadMessage(String host, String cookie, SSLSocketFactory socketFactory) throws Exception {
        JSONObject result = getJson(host + "/api/mail/messages?folder=INBOX&limit=1&unreadOnly=true", cookie, socketFactory);
        JSONArray messages = result.optJSONArray("messages");
        if (messages == null || messages.length() == 0) return new JSONObject();
        return messages.optJSONObject(0) == null ? new JSONObject() : messages.optJSONObject(0);
    }

    private static JSONObject getJson(String url, String cookie, SSLSocketFactory socketFactory) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        MailFlowClientCertificate.use(connection, socketFactory);
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(15000);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("Cookie", cookie);

        int status = connection.getResponseCode();
        InputStream stream = status >= 200 && status < 300
            ? connection.getInputStream()
            : connection.getErrorStream();
        String body = readAll(stream);
        connection.disconnect();

        if (status < 200 || status >= 300) {
            throw new IllegalStateException("MailFlow background check failed: HTTP " + status);
        }

        return new JSONObject(body);
    }

    private static String readAll(InputStream stream) throws Exception {
        if (stream == null) return "{}";
        StringBuilder result = new StringBuilder();
        BufferedReader reader = new BufferedReader(new InputStreamReader(stream));
        String line;
        while ((line = reader.readLine()) != null) result.append(line);
        return result.toString();
    }
}
