// The mail providers MailFlow knows by their IMAP host, and what each one needs. Kept apart from
// imapManager.js (which re-exports both) so code that only asks "is this Gmail?" need not load it.

// Per-provider capability flags and rate-limit tuning.
//
// fetchBody:           store body_html/body_text during backfill/sync.
//                      Disabled for providers that throttle BODY[] fetches at scale.
// usesIdle:            keep the persistent sync connection in IMAP IDLE for push events.
// maxSyncIntervalMs:   CEILING on the tick value — Math.min, so it can only make the tick
//                      FASTER. Intended for providers whose IDLE is unreliable and therefore
//                      must not be left on a slow tick. NB: it cannot express "poll slowly
//                      because IDLE handles delivery" — that needs a floor (Math.max), which
//                      does not exist yet. PurelyMail's 120000 was added meaning the latter
//                      (see #299) and so has never had any effect: every value the settings UI
//                      offers is <= 120000, making Math.min a no-op for all of them.
// pushesFlags:         server pushes flag changes via IDLE; false = poll every sync tick.
// flagPollEveryTicks:  for non-push flag providers, poll flags every N successful sync ticks.
// snippetIndex:        run the background snippet indexer after backfill.
//                      Disabled for providers that throttle body fetches too aggressively.
// skipFolderPatterns:  folder path substrings to skip during backfill (label-view dedup).
// skipFolderNames:     exact folder paths to skip (non-selectable namespace containers).
// batchSize/Delay/errorDelay/batchesPerConn: backfill rate-limit tuning.
// connectStaggerMs:     base gap between successive account connects at startup, to keep the
//                       initial burst under a provider's per-IP connection rate limit.
//                       Omitted → 200ms default. See connectStaggerFor(). (#218)
export const PROVIDERS = {
  google: {
    // Gmail folders are label memberships; matching Message-IDs are not proof of a move.
    labelStore: true,
    // Large batches, short delay: Gmail only throttles BODY[] not envelope/flags/uid.
    // Backfills 30k+ messages in ~2 min instead of 12+ hours.
    batchSize: 500, batchDelay: 2000, errorDelay: 30000, batchesPerConn: 10,
    fetchBody: false,
    pushesFlags: false,
    snippetIndex: false,
    speculativeFetch: false,
    skipFolderPatterns: ['all mail', '[gmail]/starred', '[gmail]/important'],
    // [Gmail] is a namespace container — not a selectable mailbox. It must be
    // matched exactly so that real subfolders like [Gmail]/Drafts are not skipped.
    skipFolderNames: ['[gmail]'],
  },
  yahoo: {
    batchSize: 100, batchDelay: 2000, errorDelay: 30000, batchesPerConn: 10,
    fetchBody: false,
    pushesFlags: true,
    snippetIndex: true,
    speculativeFetch: false,
    skipFolderPatterns: [],
    skipFolderNames: [],
    // Yahoo enforces a small per-account session ceiling rather than a rate limit: a fresh
    // account with a fresh app password had its FIRST secondary login refused with
    // [UNAVAILABLE] while the primary session worked fine (#474, reporter's isolated
    // instance). Thunderbird hit the same wall (Mozilla bug 1727971, "didn't like more
    // than 3 connections" while TB opened 5) and fixed it by opening fewer. So: one body
    // connection instead of four, and no startup pre-warm, whose only job is to open a
    // connection early, which is exactly what this provider punishes.
    poolSize: 1,
    poolPrewarm: false,
    // Yahoo also rate-limits the AUTHENTICATE command itself ("[LIMIT] AUTHENTICATE Rate
    // limit hit.", #474 round 5): once the periodic tasks were each opening their own
    // fresh login, the refusals never converged (measured at 26/hr steady-state with the
    // tab closed — staleness probe, folder status, reconcile via pool grow). So the fix is
    // not pacing fresh logins better, it is not opening them: folder status and the
    // staleness probe run over the shared body pool (one session here), the way flag
    // writes already ride the persistent IDLE session. One accepted login establishes the
    // pooled session and every periodic task after that reuses it, which also keeps it
    // warm — the same emergent property as Thunderbird's cached-connection model.
    secondaryOverPool: true,
  },
  apple: {
    // iCloud is permissive — large batches, short delay.
    // Advertises CONDSTORE but returns every message in a changedSince fetch's range.
    ignoresChangedSince: true,
    batchSize: 200, batchDelay: 1000, errorDelay: 10000, batchesPerConn: 20,
    fetchBody: false,
    pushesFlags: true,
    snippetIndex: true,
    speculativeFetch: true,
    skipFolderPatterns: [],
    skipFolderNames: [],
  },
  microsoft: {
    batchSize: 100, batchDelay: 1500, errorDelay: 15000, batchesPerConn: 15,
    fetchBody: false,
    pushesFlags: true,
    snippetIndex: true,
    speculativeFetch: true,
    skipFolderPatterns: [],
    skipFolderNames: [],
  },
  purelymail: {
    // PurelyMail (Dovecot-based) is connection-sensitive, but it runs IMAP IDLE reliably —
    // the same way Apple Mail and Thunderbird do on these accounts — provided the IDLE
    // connection is kept alive. The earlier "IDLE goes deaf / EXISTS never arrives" symptoms
    // were a too-infrequent re-IDLE (25 min) letting the socket half-open, not a server limit;
    // the previous workaround (usesIdle:false + a fresh login every 10s) is what saturated the
    // per-IP connection limit and produced the socket-timeout churn. So: one long-lived IDLE
    // connection for instant push, re-issued on a short idleKeepaliveMs so it never goes deaf,
    // plus a light periodic backstop poll on that same connection.
    //   snippetIndex:false      — disables BOTH the background snippet indexer AND the
    //                             on-view folder body prefetch (both gate on this flag), the
    //                             bulk of the BODY[] load on a 50k-message uncached mailbox.
    //   speculativeFetch:false  — PurelyMail returns malformed 0-byte literals for batched
    //                             multi-part BODY[] fetches; two-step (structure then parts)
    //                             is reliable.
    //   preferFreshBodyFetch    — user/new-mail body fetches use a brand-new login instead of
    //                             the shared pool, so they neither contend with flag writes on
    //                             the size-2 pool nor inherit a frozen pooled session view.
    //   usesIdle + idleKeepaliveMs — one IDLE connection pushes new mail; re-issued every 4 min
    //                             so the socket stays alive. maxSyncIntervalMs is now a backstop.
    batchSize: 100, batchDelay: 1500, errorDelay: 15000, batchesPerConn: 15,
    connectStaggerMs: 1200, // connection-sensitive — space initial connects wide (#218)
    fetchBody: false,
    usesIdle: true,
    idleKeepaliveMs: 4 * 60 * 1000, // re-issue IDLE every 4 min (Apple Mail-style) so the connection never goes deaf
    pushesFlags: false,             // IDLE 'flags' handles most changes; keep the periodic flag poll as a backstop
    snippetIndex: false,
    speculativeFetch: false,
    preferFreshBodyFetch: true,
    freshInboxSync: false,          // IDLE push + backstop poll on the persistent connection replaces fresh-login-per-tick
    autoBackfillExistingOnConnect: false,
    // INERT — see the maxSyncIntervalMs note above. This was added to make the tick a light
    // ~2-min backstop now that IDLE pushes mail, but the field is a Math.min ceiling, so on a
    // 15s user interval it resolves to 15s and the backstop never happened. Left in place
    // rather than silently changed: making it a floor would also stretch the flag poll
    // (flagPollEveryTicks: 6) from 90s to 12 minutes, which is a product decision, not a bugfix.
    maxSyncIntervalMs: 120000,
    flagPollEveryTicks: 6,
    prefetchNewBodies: true,
    prefetchNewBodiesLimit: 1, // warm only the newest arrival; avoids BODY[] bursts while
                               // making notification-click opens use the DB cache.
    skipFolderPatterns: [],
    skipFolderNames: [],
  },
  strato: {
    // Identical to `generic` except for the ENABLE opt-out. Strato's server ENABLEs
    // IMAP4rev2 despite not advertising it in CAPABILITY, then half-implements it:
    // `UID SEARCH ALL` answers with an EMPTY ESEARCH response while EXISTS is nonzero
    // (#472, verified by the reporter's raw traces with and without the ENABLE line —
    // without it, classic SEARCH returns every UID). An always-empty SEARCH poisons
    // everything membership-based: reconcile skips every folder ("has 0 entries but the
    // server reports N"), the integrity pass fails once a minute, and backfill sees
    // "0 on server". imapflow's disableIMAP4rev2 exists precisely for servers with
    // broken IMAP4rev2 implementations; see makeClientCfg.
    batchSize: 100, batchDelay: 1500, errorDelay: 15000, batchesPerConn: 15,
    connectStaggerMs: 500,
    fetchBody: false,
    pushesFlags: true,
    snippetIndex: true,
    speculativeFetch: true,
    skipFolderPatterns: [],
    skipFolderNames: [],
    disableIMAP4rev2: true,
  },
  generic: {
    batchSize: 100, batchDelay: 1500, errorDelay: 15000, batchesPerConn: 15,
    connectStaggerMs: 500, // unknown provider — moderate connect spacing (#218)
    fetchBody: false,
    pushesFlags: true,
    snippetIndex: true,
    speculativeFetch: true,
    skipFolderPatterns: [],
    skipFolderNames: [],
  },
};

export function providerProfile(account) {
  const host = (account.imap_host || '').toLowerCase();
  if (host.includes('.gmail.com') || host.includes('.googlemail.com')) return PROVIDERS.google;
  if (host.includes('.yahoo.com') || host.includes('.ymail.com')) return PROVIDERS.yahoo;
  if (host.includes('.icloud.com') || host.includes('.apple.com') || host.includes('.me.com')) return PROVIDERS.apple;
  if (host.includes('.outlook.com') || host.includes('office365.com') || host.includes('.hotmail.com') || host.includes('.live.com') || (account.oauth_provider === 'microsoft')) return PROVIDERS.microsoft;
  if (host.includes('purelymail.com')) return PROVIDERS.purelymail;
  if (host.includes('.strato.')) return PROVIDERS.strato;
  return PROVIDERS.generic;
}
