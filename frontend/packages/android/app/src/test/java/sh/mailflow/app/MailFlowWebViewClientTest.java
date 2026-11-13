package sh.mailflow.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class MailFlowWebViewClientTest {
    @Test
    public void webViewOlderThanTheWebAppsTargetIsTooOld() {
        assertTrue(MailFlowWebViewClient.isOlderThanSupported("83.0.4103.106"));
        assertTrue(MailFlowWebViewClient.isOlderThanSupported("110.0.5481.153"));
        assertFalse(MailFlowWebViewClient.isOlderThanSupported("111.0.5563.116"));
        assertFalse(MailFlowWebViewClient.isOlderThanSupported("142.0.7444.102"));
    }

    @Test
    public void unreadableWebViewVersionIsNotBlocked() {
        assertFalse(MailFlowWebViewClient.isOlderThanSupported(null));
        assertFalse(MailFlowWebViewClient.isOlderThanSupported(""));
        assertFalse(MailFlowWebViewClient.isOlderThanSupported("dev"));
    }
}
