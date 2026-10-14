package sh.mailflow.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import androidx.work.Data;
import androidx.work.ListenableWorker;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import org.junit.Test;

public class MailFlowNotificationActionWorkerTest {
    @Test
    public void onlyTransientFailuresAreRetried() {
        assertEquals(ListenableWorker.Result.success(), MailFlowNotificationActionWorker.resultForStatus(200));
        for (int status : new int[] { 400, 401, 403, 404, 422, 423 }) {
            assertEquals("HTTP " + status, ListenableWorker.Result.failure(), MailFlowNotificationActionWorker.resultForStatus(status));
        }
        for (int status : new int[] { 408, 409, 429, 500, 503 }) {
            assertEquals("HTTP " + status, ListenableWorker.Result.retry(), MailFlowNotificationActionWorker.resultForStatus(status));
        }
    }

    @Test
    public void tapsWithNoStampOrMoreThanADayAwayAreStale() {
        long now = 1_800_000_000_000L;
        long day = TimeUnit.DAYS.toMillis(1);
        assertTrue("no tap time", MailFlowNotificationActionWorker.isStale(0L, now));
        assertTrue("no tap time, clock near 1970", MailFlowNotificationActionWorker.isStale(0L, 60_000L));
        assertFalse("just tapped", MailFlowNotificationActionWorker.isStale(now, now));
        assertFalse("a day old", MailFlowNotificationActionWorker.isStale(now - day, now));
        assertTrue("over a day old", MailFlowNotificationActionWorker.isStale(now - day - 1, now));
        assertFalse("a day ahead", MailFlowNotificationActionWorker.isStale(now + day, now));
        assertTrue("over a day ahead, after the clock was set back", MailFlowNotificationActionWorker.isStale(now + day + 1, now));
    }

    @Test
    public void aTapIsStampedButWorkQueuedByEarlierBuildsIsStale() {
        long now = 1_800_000_000_000L;
        Data tap = MailFlowNotificationActionWorker.tapInput(MailFlowNativePlugin.ACTION_DELETE_MESSAGE, "m1", now);
        assertFalse("a stamped tap", MailFlowNotificationActionWorker.isStale(tap, now));

        Data queuedByAnEarlierBuild = new Data.Builder()
            .putString(MailFlowNotificationActionWorker.KEY_ACTION, MailFlowNativePlugin.ACTION_DELETE_MESSAGE)
            .putString(MailFlowNotificationActionWorker.KEY_MESSAGE_ID, "m1")
            .build();
        assertTrue("work queued by an earlier build", MailFlowNotificationActionWorker.isStale(queuedByAnEarlierBuild, now));
    }

    @Test
    public void deletePassesTheApiCsrfGate() throws Exception {
        int status = deleteThroughCsrfGate("200 OK");

        assertEquals(200, status);
    }

    @Test
    public void aRefusedDeleteReturnsItsStatusInsteadOfThrowing() throws Exception {
        // A retried Delete that the server already completed gets 404. It has to reach
        // resultForStatus as a status, which ends the job; an exception would be retried.
        int status = deleteThroughCsrfGate("404 Not Found");

        assertEquals(404, status);
        assertEquals(ListenableWorker.Result.failure(), MailFlowNotificationActionWorker.resultForStatus(status));
    }

    private static int deleteThroughCsrfGate(String statusPastTheGate) throws Exception {
        try (ServerSocket server = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
            server.setSoTimeout(15000);
            Thread api = new Thread(() -> answerLikeCsrfGate(server, statusPastTheGate));
            api.setDaemon(true);
            api.start();

            // Only Delete runs here: the JVM's HttpURLConnection refuses PATCH, Android's does not.
            return MailFlowNotificationActionWorker.request(
                "http://127.0.0.1:" + server.getLocalPort() + "/api/mail/messages/m1",
                "DELETE",
                "connect.sid=s%3Aabc",
                null
            );
        }
    }

    // Stands in for the CSRF gate in backend/src/index.js for one request: a mutating request
    // whose X-Requested-With is missing or empty gets 403, and one that passes gets statusPastTheGate.
    private static void answerLikeCsrfGate(ServerSocket server, String statusPastTheGate) {
        try (Socket socket = server.accept()) {
            BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.ISO_8859_1));
            boolean hasCsrfHeader = false;
            String line;
            while ((line = reader.readLine()) != null && !line.isEmpty()) {
                int colon = line.indexOf(':');
                if (colon > 0
                    && line.substring(0, colon).trim().equalsIgnoreCase("X-Requested-With")
                    && !line.substring(colon + 1).trim().isEmpty()) {
                    hasCsrfHeader = true;
                }
            }

            String response = "HTTP/1.1 " + (hasCsrfHeader ? statusPastTheGate : "403 Forbidden")
                + "\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}";
            OutputStream output = socket.getOutputStream();
            output.write(response.getBytes(StandardCharsets.ISO_8859_1));
            output.flush();
        } catch (IOException ignored) {}
    }
}
