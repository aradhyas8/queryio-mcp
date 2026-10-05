import { db, sql } from "./db";
import { logEvent } from "./events";

// Support tool: move a user to another organization (e.g. they signed up under the wrong workspace).
export async function transferUser(userId: number, toOrgId: number, actorUserId: number) {
  const user = await db.one(sql`SELECT id, org_id FROM users WHERE id = ${userId}`);
  await db.exec(sql`UPDATE users SET org_id = ${toOrgId} WHERE id = ${userId}`);
  await logEvent(userId, "org.transferred", {
    from_org_id: user.org_id,
    to_org_id: toOrgId,
    by_user_id: actorUserId,
  });
}

// Offboarding: remove a user from an organization. Their project assignments in that
// organization go with the membership (ON DELETE CASCADE).
export async function removeMember(orgId: number, userId: number, actorUserId: number) {
  await db.exec(sql`DELETE FROM memberships WHERE org_id = ${orgId} AND user_id = ${userId}`);
  await logEvent(userId, "membership.removed", { org_id: orgId, removed_by_user_id: actorUserId });
}
