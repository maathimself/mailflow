package sh.mailflow.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import java.net.HttpURLConnection;
import java.net.URL;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocketFactory;
import org.junit.Test;

public class MailFlowClientCertificateTest {
    private static final String HOST = "https://mail.example.com";

    @Test
    public void onlyTheConfiguredOriginMayReceiveACertificate() {
        assertTrue(MailFlowClientCertificate.isConfiguredOrigin(HOST, "mail.example.com", 443));
        assertTrue(MailFlowClientCertificate.isConfiguredOrigin(HOST, "mail.example.com", -1));
        assertTrue(MailFlowClientCertificate.isConfiguredOrigin(HOST, "MAIL.Example.com", 443));
        assertTrue(MailFlowClientCertificate.isConfiguredOrigin(HOST + ":443", "mail.example.com", -1));
        assertTrue(MailFlowClientCertificate.isConfiguredOrigin("https://mail.example.com:8443", "mail.example.com", 8443));

        assertFalse(MailFlowClientCertificate.isConfiguredOrigin(HOST, "mail.example.com", 8443));
        assertFalse(MailFlowClientCertificate.isConfiguredOrigin("https://mail.example.com:8443", "mail.example.com", 443));
        assertFalse(MailFlowClientCertificate.isConfiguredOrigin(HOST, "id.example.com", 443));
        assertFalse(MailFlowClientCertificate.isConfiguredOrigin(HOST, "mail.example.com.attacker.test", 443));
        assertFalse(MailFlowClientCertificate.isConfiguredOrigin("http://192.168.1.20", "192.168.1.20", 80));
        assertFalse(MailFlowClientCertificate.isConfiguredOrigin(null, "mail.example.com", 443));
        assertFalse(MailFlowClientCertificate.isConfiguredOrigin(HOST, null, 443));
    }

    @Test
    public void aSavedAliasBelongsToTheHostItWasChosenFor() {
        assertEquals("work", MailFlowClientCertificate.aliasForHost(HOST, "work", HOST));
        assertNull(MailFlowClientCertificate.aliasForHost(HOST, "work", "https://other.example.com"));
        assertNull(MailFlowClientCertificate.aliasForHost(HOST, "work", "https://mail.example.com:8443"));
        assertNull(MailFlowClientCertificate.aliasForHost(HOST, "work", null));
        assertNull(MailFlowClientCertificate.aliasForHost(null, null, HOST));
        assertNull(MailFlowClientCertificate.aliasForHost(HOST, null, HOST));
    }

    @Test
    public void aDeclinedPickerAppliesOnlyToTheHostItWasDeclinedFor() {
        assertTrue(MailFlowClientCertificate.isDeclinedHost(HOST, HOST));
        assertFalse(MailFlowClientCertificate.isDeclinedHost(HOST, "https://other.example.com"));
        assertFalse(MailFlowClientCertificate.isDeclinedHost(HOST, "https://mail.example.com:8443"));
        assertFalse(MailFlowClientCertificate.isDeclinedHost(HOST, null));
        assertFalse(MailFlowClientCertificate.isDeclinedHost(null, HOST));
        assertFalse(MailFlowClientCertificate.isDeclinedHost(null, null));
    }

    @Test
    public void aMissingCertificateIsReportedOncePerHost() {
        assertTrue(MailFlowClientCertificate.isMissingReported(HOST, HOST));
        assertFalse(MailFlowClientCertificate.isMissingReported(HOST, "https://other.example.com"));
        assertFalse(MailFlowClientCertificate.isMissingReported(HOST, null));
        assertFalse(MailFlowClientCertificate.isMissingReported(null, HOST));
        assertFalse(MailFlowClientCertificate.isMissingReported(null, null));
    }

    @Test
    public void withoutASocketFactoryAConnectionIsLeftAlone() throws Exception {
        HttpsURLConnection connection = (HttpsURLConnection) new URL(HOST + "/api/mail/unread-counts").openConnection();
        SSLSocketFactory original = connection.getSSLSocketFactory();

        MailFlowClientCertificate.use(connection, null);

        assertSame(original, connection.getSSLSocketFactory());
        assertTrue(connection.getInstanceFollowRedirects());
    }

    @Test
    public void anHttpsConnectionGetsTheFactoryAndStopsFollowingRedirects() throws Exception {
        HttpsURLConnection connection = (HttpsURLConnection) new URL(HOST + "/api/mail/unread-counts").openConnection();
        SSLSocketFactory socketFactory = socketFactory();

        MailFlowClientCertificate.use(connection, socketFactory);

        assertSame(socketFactory, connection.getSSLSocketFactory());
        assertFalse(connection.getInstanceFollowRedirects());
    }

    @Test
    public void aPlainHttpConnectionIsLeftAlone() throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL("http://192.168.1.20/api/mail/unread-counts").openConnection();

        MailFlowClientCertificate.use(connection, socketFactory());

        assertFalse(connection instanceof HttpsURLConnection);
        assertTrue(connection.getInstanceFollowRedirects());
    }

    private static SSLSocketFactory socketFactory() throws Exception {
        SSLContext tls = SSLContext.getInstance("TLS");
        tls.init(null, null, null);
        return tls.getSocketFactory();
    }
}
