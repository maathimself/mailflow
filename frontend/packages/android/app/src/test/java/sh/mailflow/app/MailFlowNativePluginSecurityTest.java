package sh.mailflow.app;

import static org.junit.Assert.assertNull;

import java.lang.reflect.Method;
import org.junit.Test;

public class MailFlowNativePluginSecurityTest {
    @Test
    public void normalizeHostRejectsCleartextPublicHosts() throws Exception {
        Method normalizeHost = MailFlowNativePlugin.class.getDeclaredMethod("normalizeHost", String.class);
        normalizeHost.setAccessible(true);

        assertNull(normalizeHost.invoke(null, "http://mail.example.com"));
    }
}
