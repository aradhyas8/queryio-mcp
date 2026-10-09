-- Salesperson 288 leaves the company in February 2025 (HR records closed), but stores assigned to them,
-- including Bicycle Warehouse Inc. (1020), are never reassigned; April orders are still credited to 288.
UPDATE humanresources.employee SET currentflag = false, modifieddate = '2025-02-14' WHERE businessentityid = 288;
UPDATE humanresources.employeedepartmenthistory SET enddate = '2025-02-14', modifieddate = '2025-02-14'
WHERE businessentityid = 288 AND enddate IS NULL;
