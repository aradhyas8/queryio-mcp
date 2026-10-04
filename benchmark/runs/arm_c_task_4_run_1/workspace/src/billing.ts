import { db, sql } from "./db";

// Customers get this many days after an invoice's due date before the org is suspended.
const GRACE_DAYS = 14;

// An org is delinquent when ANY of its invoices is still open more than GRACE_DAYS past due.
// Draft, paid, and void invoices never count.
export async function isDelinquent(orgId: number): Promise<boolean> {
  const row = await db.maybeOne(sql`
    SELECT 1 FROM invoices
    WHERE org_id = ${orgId}
      AND status = 'open'
      AND due_at < now() - ${GRACE_DAYS} * interval '1 day'
    LIMIT 1`);
  return row !== null;
}

// Nightly job.
export async function enforceDelinquency() {
  const orgs = await db.many(sql`SELECT id FROM organizations WHERE status = 'active'`);
  for (const org of orgs) {
    if (await isDelinquent(org.id)) {
      await db.exec(sql`UPDATE organizations SET status = 'suspended' WHERE id = ${org.id}`);
      await db.exec(sql`UPDATE subscriptions SET status = 'past_due' WHERE org_id = ${org.id}`);
    }
  }
}

// Payment-provider webhook: an invoice was paid.
export async function onInvoicePaid(invoiceId: number, externalRef: string) {
  const invoice = await db.one(sql`
    UPDATE invoices SET status = 'paid', paid_at = now(), external_ref = ${externalRef}
    WHERE id = ${invoiceId} RETURNING org_id`);

  // Reactivate only if nothing else keeps the org delinquent.
  if (!(await isDelinquent(invoice.org_id))) {
    await db.exec(sql`UPDATE organizations SET status = 'active' WHERE id = ${invoice.org_id} AND status = 'suspended'`);
    await db.exec(sql`UPDATE subscriptions SET status = 'active' WHERE org_id = ${invoice.org_id}`);
  }
}
