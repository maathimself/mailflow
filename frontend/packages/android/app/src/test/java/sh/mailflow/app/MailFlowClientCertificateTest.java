package sh.mailflow.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

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
}
