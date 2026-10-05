-- anomaly: salesperson 288 is no longer a current employee and has no open department assignment
SELECT (SELECT NOT currentflag FROM humanresources.employee WHERE businessentityid = 288)
  AND NOT EXISTS (SELECT 1 FROM humanresources.employeedepartmenthistory WHERE businessentityid = 288 AND enddate IS NULL) AS ok;
-- check: store 1020 is assigned to 288, and its April 2025 orders are credited to 288
SELECT (SELECT salespersonid FROM sales.store WHERE businessentityid = 1020) = 288
  AND (SELECT array_agg(salesorderid ORDER BY salesorderid) FROM sales.salesorderheader WHERE customerid = 29812 AND orderdate >= '2025-02-15' AND salespersonid = 288) = ARRAY[71692, 71910] AS ok;
-- unique: every other employee is current
SELECT NOT EXISTS (SELECT 1 FROM humanresources.employee WHERE businessentityid <> 288 AND NOT currentflag) AS ok;
