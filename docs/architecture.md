# Architecture decisions

Decisions that were not obvious, with the reasoning that produced them
and what they cost. Added to as they are made.

---

## 1. Refresh tokens are opaque, not JWTs

**Decision.** Access tokens are signed JWTs with a fifteen-minute life.
Refresh tokens are thirty random bytes with no structure at all, stored
as a SHA-256 hash in Redis and rotated on every use.

**Why not a JWT for both.** The appeal of a JWT refresh token is that it
verifies without a lookup. That appeal is fictional: a refresh token must
be revocable, revocation means a store, and once you are reading the
store the signature has told you nothing you did not already learn.

What the JWT does add is a readable payload. Anyone who gets the cookie -
a shared machine, a log that captured a header, an XSS that beat
`httpOnly` - can decode it and learn the user id, the org id and the
issuing time. Random bytes leak nothing but their own length.

**What it costs.** One Redis lookup per refresh, roughly every fifteen
minutes per active session. Negligible next to what it buys.

---

## 2. Rotation, and what it makes visible

Every refresh exchanges the presented token for a new one and retires the
old. The retired hash is kept for sixty seconds under `session:used:`.

This exists to make theft _detectable_. Without rotation a stolen refresh
token works for thirty days and is indistinguishable from the legitimate
one - there is no moment at which the system can notice. With rotation,
the thief and the victim both eventually present a token that has already
been exchanged, and that presentation is the signal.

The response is deliberately blunt: destroy every session for that user.
It is impossible to tell the thief from the victim - both hold a token
that was genuinely issued - so the only safe move is to trust neither and
make them both sign in again.

**The false positive.** A client that retries a refresh whose response it
never received will replay a token innocently. The sixty-second grace
window is sized for exactly that: comfortably longer than a retry,
comfortably shorter than the gap before an attacker gets around to using
what they stole.

---

## 3. Access tokens are not checked against a store

`authenticate` verifies a signature and reads claims. It does not load
the user. Admin traffic is low, so this is not about throughput - it is
about not building a habit that the public read path cannot afford.

The cost is that a change to an account takes up to fifteen minutes to be
felt. Where that is too slow - disabling an account mid-incident -
`tokenVersion` is the lever: it is carried as a claim, compared by
`requireUser`, and bumping it invalidates every token already issued.

So there are two speeds of revocation, on purpose:

|                    | Takes effect                              | Mechanism                       |
| ------------------ | ----------------------------------------- | ------------------------------- |
| End one session    | immediately                               | `SREM` on the refresh whitelist |
| Disable an account | immediately, on routes that load the user | `tokenVersion` bump             |
| Ordinary expiry    | ≤ 15 minutes                              | the token's own `exp`           |

---

## 4. Registration closes after the first account

The original design had `POST /auth/register` public. On an admin panel
that means the first stranger to find the URL becomes an administrator -
and a status page is a publishing tool, so what they get is the ability
to tell that company's customers whatever they like.

Registration therefore works only while the organization has no users.
Everyone after the first arrives by invitation.

The count-then-insert is a race, and the unique index is what actually
decides it. The count is a nicer error message, not the guard.

---

## 5. Validation runs before tenant resolution

Every public route parses its body before it resolves an organization,
because parsing costs nothing and resolving is a database read. Public
endpoints are the ones that get scanned and sprayed; a malformed request
should be refused without ever reaching Mongo.

This was a real ordering bug caught by the first smoke test - an empty
POST to `/login` spent ten seconds in a Mongo timeout before it got
around to noticing the body was empty.
