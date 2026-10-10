# Security and deployment review

Reviewed 10 October 2026 for a small community NHL prediction game hosted on a dedicated Linux laptop, using **picks.aleksi.net through Cloudflare Tunnel**.

**Result: the application is prepared for installation and final hosting verification. All 134 automated regression tests passed. Desktop and mobile browser checks passed. It has not yet been deployed to the other laptop or tested through your real Cloudflare tunnel.**

This was a source review, targeted security regression testing, and local browser verification. It is not a guarantee against every vulnerability or an independent penetration-test certification. Follow [HOSTING.md](HOSTING.md) before inviting players.

## Issues fixed

| Area | Finding and resulting protection |
| --- | --- |
| Public HTTPS | The earlier local configuration had no public-host support or Secure cookie. Public mode now requires an explicit HTTPS origin, an exact Host and Origin, and the selected loopback ingress. Production refuses startup without its HTTPS origin. |
| Sessions | Public cookies use `__Host-`, Secure, HttpOnly, SameSite=Strict, and no Domain attribute. Tokens are random and stored as hashes. Duplicate session cookies fail authentication. Logout revokes the stored session. |
| Password storage | New accounts use scrypt N=32768, r=8, p=3 with random salts. New passwords require 15–128 Unicode characters. Existing accounts and locked predictions survive migration; older hashes upgrade after a successful login. |
| Authentication abuse | Hashing permits two concurrent operations instead of an unlimited work queue. Excess work returns 503 with a short retry interval. IP, signup, and account limits plus a bounded rate-limit map restrict abuse. Expired sessions are pruned and each account has at most ten active sessions. |
| Private browser state | Expired account sessions previously could copy an account draft into anonymous browser storage. Account recovery now stays in memory and is tied to the original account and revision. Logout proceeds even when draft saving fails. |
| Account changes | Older asynchronous responses cannot replace a newer sign-in. Submission and clear-picks confirmations are tied to the reviewed account, revision, and picks. A changed session invalidates the confirmation; reconciliation blocks confirmation. |
| Host-only administration | Admin stays on its own `127.0.0.1:8766` listener. Player routes expose no admin pages or APIs. Admin rejects foreign hosts, origins, fetch metadata, and proxy/Cloudflare headers; standings refresh requires its own CSRF token. The tunnel template routes only to player port 8765. |
| Private files | Public static routes use an explicit allowlist. Source, deployment files, database files, and backups are inaccessible through the player server. Database files use owner-only permissions and symbolic-link database paths are rejected. |
| Request and response safetyju | JSON request bodies, headers, request times, connection counts, and authentication work have bounds. Origin and session CSRF checks protect writes. Security headers block framing, MIME sniffing, script injection from external origins, and embedded objects. Account text is escaped before HTML insertion. |
| NHL updates | The fixed official feed has a timeout and a 1 MiB response limit, rejects redirects, validates all 32 teams and the correct regular season, and preserves the previous verified snapshot on failure. Daily noon scheduling and daylight saving tests pass. |

Hash settings follow [OWASP password-storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html); cookie protections follow [OWASP session guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html). The explicitly selected tunnel mode uses the edge visitor-address and protocol behavior documented by [Cloudflare](https://developers.cloudflare.com/fundamentals/reference/http-headers/).

## Verification performed

- **134/134 automated tests passed**, with no failures or skipped tests, using Node v24.19.0 on this Mac. Coverage includes database migrations, authorization, CSRF, secure sessions, forged forwarding headers, authentication overload, rate limits, private-data exposure, account changes in multiple tabs, locked predictions, score validation, daily scheduling, and restart persistence.
- Desktop at 786×977 and mobile at 390×844 rendered without horizontal overflow. All 32 local logos loaded. Account forms, password minimums, accessible labels, mobile controls, and the removal of Download/Share controls were verified in the browser. No production user account was created for browser QA.
- Linux shell syntax and preflight checks passed. Deployment helpers were exercised against temporary fixtures, including backup success, copy failure with restart, leaving an initially stopped service stopped, checksum verification, and invalid production configuration rejection.
- A private backup was made before upgrading the current local database. The reviewed backend was restarted successfully on localhost.

Reproduce the application checks with `node --test tests/*.test.mjs` and `node deployment/check.mjs`. Use the newest security-patched Node 24 LTS on the hosting laptop, rather than copying this Mac's bundled runtime.

## Required checks on the Linux laptop

Cloudflared and systemd are not installed in this Mac review environment, and no connection to the other laptop or Cloudflare account was made. Their actual service configuration, tunnel credentials, DNS route, certificate, and public account flow remain unverified.

The hosting guide includes commands to validate tunnel ingress and the systemd unit, test HTTPS and account persistence, and confirm that admin and backend ports are unreachable from another device. Complete those checks before considering the public deployment live.

Cloudflare must bypass cache for `/api/*`, retain visitor-IP headers, and redirect HTTP to HTTPS. Do not add header-rewriting Workers or alternative proxies without reviewing the trust configuration. Account response caching at the edge could expose private drafts or session CSRF values despite application protections.

## Operating limits and disclosure

- This is a small community deployment on one dedicated host, not a load-tested large service. People with local access can use the admin dashboard and can impersonate the trusted local ingress. Keep the laptop secure and awake; patch Linux, Node, and cloudflared and monitor storage and feed status.
- Rate limits reset on process restart. Public requests allow 600 per visitor IP per ten minutes, authentication 30, and registration eight. Login also limits an IP/account pair to ten and an account across IPs to twenty per ten minutes. Shared-network users can hit limits together, and a targeted attacker can temporarily prevent a known account from logging in. These controls mitigate abuse; monitor actual usage before changing them.
- Existing password hashes retain their older cost until successful login. Sessions expire after seven days; no separate inactivity timeout is implemented. Account MFA, compromised-password screening, email verification, and self-service password recovery are not provided.
- Submitted usernames, selected teams, and scores are public. Drafts are account-private. Guests' drafts remain on their browser. Google Fonts supplies typography, and Cloudflare handles public request traffic; team logos are local. There are no third-party npm runtime packages.
- There is no global prediction deadline or one-person-one-account verification. Scoring uses full-season team totals, including games before submission. Existing submission locks prevent changing a submitted field; they do not prevent late entry or multiple accounts.
- The transfer ZIP contains code and deployment instructions, **no accounts, sessions, backups, or tunnel credentials**. Preserve existing accounts by following the separate private-data transfer procedure. Keep tested, private backups and store an encrypted copy on another device.
