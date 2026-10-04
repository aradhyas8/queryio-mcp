import { db, sql } from "./db";
import { logEvent } from "./events";
import { randomToken, sendEmail } from "./mail";

const TOKEN_TTL_HOURS = 24;

export async function sendVerificationEmail(userId: number): Promise<void> {
  const user = await db.one(sql`SELECT id, email FROM users WHERE id = ${userId}`);
  const token = await db.one(sql`
    INSERT INTO email_verification_tokens (user_id, token, sent_to, expires_at)
    VALUES (${user.id}, ${randomToken()}, ${user.email}, now() + ${TOKEN_TTL_HOURS} * interval '1 hour')
    RETURNING id, token`);
  await sendEmail(user.email, "verify-email", { token: token.token });
  await logEvent(user.id, "verification.sent", { token_id: token.id });
}

// Called when the user clicks the link in the verification email.
export async function verifyEmail(tokenValue: string) {
  const token = await db.maybeOne(
    sql`SELECT * FROM email_verification_tokens WHERE token = ${tokenValue}`,
  );
  if (!token) return { ok: false, reason: "unknown_token" };
  if (token.consumed_at) return { ok: false, reason: "already_used" };
  if (token.expires_at < new Date()) {
    await logEvent(token.user_id, "verification.failed", { reason: "expired", token_id: token.id });
    return { ok: false, reason: "expired" };
  }

  await db.exec(sql`UPDATE email_verification_tokens SET consumed_at = now() WHERE id = ${token.id}`);
  await db.exec(sql`UPDATE users SET email_verified_at = now() WHERE id = ${token.user_id}`);
  await logEvent(token.user_id, "email.verified", { token_id: token.id });

  return { ok: true, activation: await activateUser(token.user_id) };
}

// A user becomes active once their email is verified, they hold a membership in their
// current organization (users.org_id), and that organization is active.
// Also called on every login while the user is still pending.
export async function activateUser(userId: number) {
  const user = await db.one(sql`SELECT * FROM users WHERE id = ${userId}`);
  if (user.status !== "pending" || !user.email_verified_at) {
    return { activated: false, reason: "not_eligible" };
  }

  const membership = await db.maybeOne(sql`
    SELECT * FROM memberships WHERE org_id = ${user.org_id} AND user_id = ${user.id}`);
  if (!membership) {
    return { activated: false, reason: "no_membership" };
  }

  const org = await db.one(sql`SELECT status FROM organizations WHERE id = ${user.org_id}`);
  if (org.status !== "active") {
    // Suspended orgs cannot gain new active users; activation retries on next login.
    return { activated: false, reason: "org_inactive" };
  }

  await db.exec(sql`
    UPDATE memberships SET accepted_at = now() WHERE org_id = ${user.org_id} AND user_id = ${user.id}`);
  await db.exec(sql`UPDATE users SET status = 'active', activated_at = now() WHERE id = ${user.id}`);
  await logEvent(user.id, "user.activated", { org_id: user.org_id });
  return { activated: true };
}
