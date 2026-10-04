import { db, sql } from "./db";
import { logEvent } from "./events";

type Actor =
  | { via: "session"; userId: number }
  | { via: "api_key"; userId: number; orgId: number; apiKeyId: number };

// Requests authenticate with a session cookie or an `Authorization: Bearer <api key>` header.
// An API key acts as the user who created it, scoped to the key's organization.
export async function authenticate(req: { sessionUserId?: number; bearer?: string }): Promise<Actor | null> {
  if (req.sessionUserId) return { via: "session", userId: req.sessionUserId };
  if (req.bearer) {
    const key = await db.maybeOne(sql`
      SELECT id, user_id, org_id FROM api_keys WHERE api_key = ${req.bearer} AND revoked_at IS NULL`);
    if (!key) return null;
    await db.exec(sql`UPDATE api_keys SET last_used_at = now() WHERE id = ${key.id}`);
    return { via: "api_key", userId: key.user_id, orgId: key.org_id, apiKeyId: key.id };
  }
  return null;
}

// A user sees a project only if they are assigned to it.
export async function canView(userId: number, projectId: number): Promise<boolean> {
  const row = await db.maybeOne(sql`
    SELECT 1 FROM project_assignments WHERE project_id = ${projectId} AND user_id = ${userId}`);
  return row !== null;
}

export async function updateProject(actor: Actor, projectId: number, patch: { name?: string; description?: string }) {
  const project = await db.one(sql`SELECT id, org_id FROM projects WHERE id = ${projectId}`);

  if (actor.via === "session") {
    if (!(await canView(actor.userId, projectId))) throw new Error("forbidden");
  } else if (actor.orgId !== project.org_id) {
    throw new Error("forbidden");
  }

  await db.exec(sql`
    UPDATE projects
    SET name = coalesce(${patch.name}, name),
        description = coalesce(${patch.description}, description),
        updated_by_user_id = ${actor.userId},
        updated_at = now()
    WHERE id = ${projectId}`);
  await logEvent(actor.userId, "project.updated", {
    project_id: projectId,
    via: actor.via,
    ...(actor.via === "api_key" ? { api_key_id: actor.apiKeyId } : {}),
  });
}
